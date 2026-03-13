import { useController } from '@/contexts/controller';
import { MAX_BEASTS_PER_ATTACK, useGameDirector } from '@/contexts/GameDirector';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { useGameStore } from '@/stores/gameStore';
import type { Beast } from '@/types/game';
import { delay } from '@/utils/utils';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  calculateRevivalRequired,
  isOwnerIgnored, isOwnerTargetedForPoison, getTargetedPoisonAmount,
  isBeastTargetedForPoison, getTargetedBeastPoisonAmount,
  hasDiplomacyMatch, selectOptimalBeasts,
} from '../utils/beasts';

// ── Constants ────────────────────────────────────────────────────────
const TICK_MS = 5_000;           // Autopilot polling interval
const TX_SETTLE_MS = 3_000;      // Delay between wallet calls
const COOLDOWN_MS = 30_000;      // Backoff after failures
const ATTACK_TIMEOUT_MS = 90_000; // Safety timeout for stuck attacks

export function useAutopilotOrchestrator() {
  // ── Context values → refs (so the interval can read them) ────────
  const { executeGameAction } = useGameDirector();
  const { tokenBalances } = useController();

  const executeRef = useRef(executeGameAction);
  const balancesRef = useRef(tokenBalances);
  executeRef.current = executeGameAction;
  balancesRef.current = tokenBalances;

  // ── Zustand subscriptions (for UI rendering only) ────────────────
  const { selectedBeasts, summit, attackInProgress, applyingPotions,
    collection, attackMode, autopilotLog, autopilotEnabled,
    setSelectedBeasts, setAppliedExtraLifePotions,
    setAutopilotEnabled } = useGameStore();

  const {
    attackStrategy, useRevivePotions, revivePotionMax, revivePotionMaxPerBeast,
    revivePotionsUsed, useAttackPotions, attackPotionMax, attackPotionMaxPerBeast,
    attackPotionsUsed, maxBeastsPerAttack, questMode, questFilters,
    setRevivePotionsUsed, setAttackPotionsUsed, setExtraLifePotionsUsed,
    setPoisonPotionsUsed,
  } = useAutopilotStore();

  // ── Internal refs ────────────────────────────────────────────────
  const executingRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const lastSummitBeastRef = useRef<number | null>(null);
  const poisonedTokenIdRef = useRef<number | null>(null);
  const attackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Derived values for UI ────────────────────────────────────────
  const isSavage = Boolean(collection.find(beast => beast.token_id === summit?.beast?.token_id));
  const revivalPotionsRequired = calculateRevivalRequired(selectedBeasts);
  const hasEnoughRevivePotions = (tokenBalances["REVIVE"] || 0) >= revivalPotionsRequired;
  const enableAttack = (attackMode === 'autopilot' && !attackInProgress) || ((!isSavage || attackMode !== 'safe') && summit?.beast && !attackInProgress && selectedBeasts.length > 0 && hasEnoughRevivePotions);

  const collectionWithCombat = useMemo<Beast[]>(() => {
    if (summit && collection.length > 0) {
      return selectOptimalBeasts(collection, summit, {
        useRevivePotions, revivePotionMax, revivePotionMaxPerBeast, revivePotionsUsed,
        useAttackPotions, attackPotionMax, attackPotionMaxPerBeast, attackPotionsUsed,
        autopilotEnabled, questMode, questFilters,
      });
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summit?.beast?.token_id, summit?.beast?.extra_lives, summit?.beast?.current_health, collection.length, revivePotionsUsed, attackPotionsUsed, useRevivePotions, useAttackPotions, questMode, questFilters, maxBeastsPerAttack, attackStrategy, autopilotEnabled]);

  // ── Helpers ──────────────────────────────────────────────────────
  const setCooldown = () => {
    cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
    console.log(`[Autopilot] Cooldown set for ${COOLDOWN_MS / 1000}s`);
  };

  const clearAttackTimeout = () => {
    if (attackTimeoutRef.current) {
      clearTimeout(attackTimeoutRef.current);
      attackTimeoutRef.current = null;
    }
  };

  const startAttackTimeout = () => {
    clearAttackTimeout();
    attackTimeoutRef.current = setTimeout(() => {
      const { attackInProgress: stuck } = useGameStore.getState();
      if (stuck) {
        console.warn('[Autopilot] Attack timed out — force-clearing');
        useGameStore.getState().setAttackInProgress(false);
      }
      setCooldown();
      attackTimeoutRef.current = null;
    }, ATTACK_TIMEOUT_MS);
  };

  // ── Action executors (sequential, awaited) ───────────────────────

  const doApplyExtraLife = async (beastId: number, amount: number): Promise<boolean> => {
    const gs = useGameStore.getState();
    gs.setApplyingPotions(true);
    gs.setAutopilotLog('Adding extra lives...');
    try {
      const result = await executeRef.current({ type: 'add_extra_life', beastId, extraLifePotions: amount });
      if (!result) setCooldown();
      return !!result;
    } finally {
      await delay(TX_SETTLE_MS);
    }
  };

  const doApplyPoison = async (beastId: number, amount: number): Promise<boolean> => {
    const gs = useGameStore.getState();
    gs.setApplyingPotions(true);
    gs.setAutopilotLog('Applying poison...');
    try {
      const result = await executeRef.current({ type: 'apply_poison', beastId, count: amount });
      if (!result) setCooldown();
      return !!result;
    } finally {
      await delay(TX_SETTLE_MS);
    }
  };

  const doAttack = async (beasts: Beast[], extraLifePotions: number): Promise<boolean> => {
    const gs = useGameStore.getState();
    gs.setBattleEvents([]);
    gs.setAttackInProgress(true);
    startAttackTimeout();
    try {
      const result = await executeRef.current({
        type: 'attack',
        beasts: beasts.map((beast: Beast) => [beast, 1, beast.combat?.attackPotions || 0]),
        safeAttack: false, vrf: true,
        extraLifePotions,
        attackPotions: beasts[0]?.combat?.attackPotions || 0,
      });
      clearAttackTimeout();
      if (!result) {
        setCooldown();
        gs.setAttackInProgress(false);
      }
      return !!result;
    } catch (error) {
      console.error('[Autopilot] attack error:', error);
      setCooldown();
      clearAttackTimeout();
      gs.setAttackInProgress(false);
      return false;
    } finally {
      await delay(TX_SETTLE_MS);
    }
  };

  const doAttackUntilCapture = async (allBeasts: Beast[], extraLifePotions: number): Promise<boolean> => {
    const gs = useGameStore.getState();
    gs.setBattleEvents([]);
    gs.setAttackInProgress(true);
    startAttackTimeout();

    const beastTuples: [Beast, number, number][] = allBeasts.map(b => [b, 1, b.combat?.attackPotions || 0]);
    const batches: [Beast, number, number][][] = [];
    for (let i = 0; i < beastTuples.length; i += MAX_BEASTS_PER_ATTACK) {
      batches.push(beastTuples.slice(i, i + MAX_BEASTS_PER_ATTACK));
    }

    try {
      const poisonedThisSequence = new Set<number>();

      for (let i = 0; i < batches.length; i++) {
        // Settle between batches
        if (i > 0) await delay(TX_SETTLE_MS);

        // Re-read state between batches
        const currentSummit = useGameStore.getState().summit;
        if (!currentSummit) break;

        const ap = useAutopilotStore.getState();
        const currentCollection = useGameStore.getState().collection;
        const isMyBeast = currentCollection.some(b => b.token_id === currentSummit.beast.token_id);

        if (isMyBeast) { gs.setAutopilotLog('Summit captured — halting attack'); break; }
        if (isOwnerIgnored(currentSummit.owner, ap.ignoredPlayers)) { gs.setAutopilotLog('Halted: ignored player took summit'); break; }
        if (ap.skipSharedDiplomacy && hasDiplomacyMatch(currentCollection, currentSummit.beast)) { gs.setAutopilotLog('Halted: shared diplomacy'); break; }

        // Inter-batch targeted poison
        if (!poisonedThisSequence.has(currentSummit.beast.token_id)) {
          const poisonAmount = getInterBatchPoisonAmount(currentSummit, ap, balancesRef.current);
          if (poisonAmount > 0) {
            await doApplyPoison(currentSummit.beast.token_id, poisonAmount);
            poisonedThisSequence.add(currentSummit.beast.token_id);
            await delay(TX_SETTLE_MS);
          }
        }

        const result = await executeRef.current({
          type: 'attack_until_capture',
          beasts: batches[i],
          extraLifePotions,
        });

        if (!result) {
          const post = useGameStore.getState();
          const didCapture = post.summit && post.collection.some(b => b.token_id === post.summit!.beast.token_id);
          if (!didCapture) setCooldown();
          break;
        }
      }
      return true;
    } catch (error) {
      console.error('[Autopilot] all_out error:', error);
      setCooldown();
      return false;
    } finally {
      clearAttackTimeout();
      gs.setAttackInProgress(false);
      await delay(TX_SETTLE_MS);
    }
  };

  // ── The tick function (ALL autopilot logic) ──────────────────────

  const tick = useCallback(async () => {
    // Hard lock: only one tick runs at a time
    if (executingRef.current) return;

    const gs = useGameStore.getState();
    const ap = useAutopilotStore.getState();
    const balances = balancesRef.current;

    if (!gs.autopilotEnabled || !gs.summit) return;
    if (gs.attackInProgress || gs.applyingPotions) return;

    // Clear cooldown on summit beast change
    if (gs.summit.beast.token_id !== lastSummitBeastRef.current) {
      lastSummitBeastRef.current = gs.summit.beast.token_id;
      cooldownUntilRef.current = 0;
      poisonedTokenIdRef.current = null;
    }

    // Check cooldown
    if (Date.now() < cooldownUntilRef.current) {
      const remaining = Math.ceil((cooldownUntilRef.current - Date.now()) / 1000);
      gs.setAutopilotLog(`Cooldown: ${remaining}s`);
      return;
    }

    // Lock
    executingRef.current = true;

    try {
      const myBeast = gs.collection.find(b => b.token_id === gs.summit!.beast.token_id);
      const ownerIgnored = isOwnerIgnored(gs.summit.owner, ap.ignoredPlayers);
      const diplomacyMatch = ap.skipSharedDiplomacy && hasDiplomacyMatch(gs.collection, gs.summit.beast);
      const shouldSkip = ownerIgnored || diplomacyMatch;

      // ── My beast on summit: extra life logic ───────────────────
      if (myBeast) {
        if (ap.extraLifeStrategy === 'aggressive' && myBeast.extra_lives >= 0 && myBeast.extra_lives < ap.extraLifeReplenishTo) {
          const amount = Math.min(ap.extraLifeTotalMax - ap.extraLifePotionsUsed, ap.extraLifeReplenishTo - myBeast.extra_lives);
          if (amount > 0) {
            await doApplyExtraLife(gs.summit!.beast.token_id, amount);
          }
        }
        gs.setAutopilotLog('Waiting for trigger...');
        return;
      }

      // ── Targeted poison (beast-level) ──────────────────────────
      if (ap.targetedPoisonBeasts.length > 0 && isBeastTargetedForPoison(gs.summit.beast.token_id, ap.targetedPoisonBeasts)) {
        const beastAmount = getTargetedBeastPoisonAmount(gs.summit.beast.token_id, ap.targetedPoisonBeasts);
        const remaining = Math.max(0, ap.poisonTotalMax - ap.poisonPotionsUsed);
        const pb = balances?.["POISON"] || 0;
        const amount = Math.min(beastAmount, pb, remaining);
        if (amount > 0) {
          await doApplyPoison(gs.summit.beast.token_id, amount);
          return;
        }
      }

      // ── Targeted poison (player-level) ─────────────────────────
      if (ap.targetedPoisonPlayers.length > 0 && isOwnerTargetedForPoison(gs.summit.owner, ap.targetedPoisonPlayers)) {
        const playerAmount = getTargetedPoisonAmount(gs.summit.owner, ap.targetedPoisonPlayers);
        const remaining = Math.max(0, ap.poisonTotalMax - ap.poisonPotionsUsed);
        const pb = balances?.["POISON"] || 0;
        const amount = Math.min(playerAmount, pb, remaining);
        if (amount > 0) {
          await doApplyPoison(gs.summit.beast.token_id, amount);
          return;
        }
      }

      // ── Aggressive poison (once per summit beast) ──────────────
      if (ap.poisonStrategy === 'aggressive' && !shouldSkip
        && poisonedTokenIdRef.current !== gs.summit.beast.token_id) {
        if ((ap.poisonMinPower <= 0 || gs.summit.beast.power >= ap.poisonMinPower)
          && (ap.poisonMinHealth <= 0 || gs.summit.beast.current_health >= ap.poisonMinHealth)) {
          const remaining = Math.max(0, ap.poisonTotalMax - ap.poisonPotionsUsed);
          const pb = balances?.["POISON"] || 0;
          const amount = Math.min(ap.poisonAggressiveAmount, pb, remaining);
          if (amount > 0) {
            const fired = await doApplyPoison(gs.summit.beast.token_id, amount);
            if (fired) poisonedTokenIdRef.current = gs.summit.beast.token_id;
            return;
          }
        }
      }

      // ── Skip checks ────────────────────────────────────────────
      if (shouldSkip) {
        if (diplomacyMatch) gs.setAutopilotLog('Ignoring shared diplomacy');
        else if (ownerIgnored) {
          const owner = gs.summit.owner.replace(/^0x0+/, '0x').toLowerCase();
          const player = ap.ignoredPlayers.find(p => p.address === owner);
          gs.setAutopilotLog(`Ignoring ${player?.name ?? 'player'}`);
        }
        return;
      }

      // ── Conservative poison ────────────────────────────────────
      if (ap.poisonStrategy === 'conservative'
        && gs.summit.beast.extra_lives >= ap.poisonConservativeExtraLivesTrigger
        && gs.summit.poison_count < ap.poisonConservativeAmount
        && poisonedTokenIdRef.current !== gs.summit.beast.token_id
        && (ap.poisonMinPower <= 0 || gs.summit.beast.power >= ap.poisonMinPower)
        && (ap.poisonMinHealth <= 0 || gs.summit.beast.current_health >= ap.poisonMinHealth)) {
        const remaining = Math.max(0, ap.poisonTotalMax - ap.poisonPotionsUsed);
        const pb = balances?.["POISON"] || 0;
        const amount = Math.min(ap.poisonConservativeAmount - gs.summit.poison_count, pb, remaining);
        if (amount > 0) {
          const fired = await doApplyPoison(gs.summit.beast.token_id, amount);
          if (fired) poisonedTokenIdRef.current = gs.summit.beast.token_id;
          // Defer attack to next tick
          return;
        }
      }

      // ── Compute beasts for attack ──────────────────────────────
      const beasts = selectOptimalBeasts(gs.collection, gs.summit, {
        useRevivePotions: ap.useRevivePotions, revivePotionMax: ap.revivePotionMax,
        revivePotionMaxPerBeast: ap.revivePotionMaxPerBeast, revivePotionsUsed: ap.revivePotionsUsed,
        useAttackPotions: ap.useAttackPotions, attackPotionMax: ap.attackPotionMax,
        attackPotionMaxPerBeast: ap.attackPotionMaxPerBeast, attackPotionsUsed: ap.attackPotionsUsed,
        autopilotEnabled: true, questMode: ap.questMode, questFilters: ap.questFilters,
      });

      if (beasts.length === 0) {
        gs.setAutopilotLog('No eligible beasts available');
        return;
      }

      // ── Extra life potions for attack ──────────────────────────
      let extraLifePotions = 0;
      if (ap.extraLifeStrategy === 'after_capture') {
        extraLifePotions = Math.min(ap.extraLifeTotalMax - ap.extraLifePotionsUsed, ap.extraLifeMax);
      } else if (ap.extraLifeStrategy === 'aggressive') {
        extraLifePotions = Math.min(ap.extraLifeTotalMax - ap.extraLifePotionsUsed, ap.extraLifeReplenishTo);
      }

      // ── Attack dispatch ────────────────────────────────────────
      if (ap.attackStrategy === 'never') {
        gs.setAutopilotLog('Attack strategy: never');
        return;
      }

      if (ap.attackStrategy === 'all_out') {
        console.log('[Autopilot] Firing all_out attack', { beasts: beasts.length, extraLifePotions });
        gs.setAutopilotLog(`Attacking with ${beasts.length} beasts...`);
        await doAttackUntilCapture(beasts, extraLifePotions);
        return;
      }

      if (ap.attackStrategy === 'guaranteed') {
        const attackBeasts = beasts.slice(0, ap.maxBeastsPerAttack);
        if (attackBeasts.length === 0) { gs.setAutopilotLog('No beasts in range'); return; }

        const totalSummitHealth = ((gs.summit.beast.health + gs.summit.beast.bonus_health) * gs.summit.beast.extra_lives) + gs.summit.beast.current_health;
        const totalDamage = attackBeasts.reduce((acc, b) => acc + (b.combat?.estimatedDamage ?? 0), 0);
        if (totalDamage < totalSummitHealth * 1.1) {
          gs.setAutopilotLog(`Damage insufficient: ${Math.floor(totalDamage)} / ${Math.floor(totalSummitHealth * 1.1)} needed`);
          return;
        }

        const msg = `Attacking with ${attackBeasts.length} beast${attackBeasts.length > 1 ? 's' : ''}...`;
        console.log('[Autopilot]', msg, { extraLifePotions });
        gs.setAutopilotLog(msg);
        await doAttack(attackBeasts, extraLifePotions);
        return;
      }
    } catch (error) {
      console.error('[Autopilot] tick error:', error);
      setCooldown();
    } finally {
      executingRef.current = false;
    }
  }, []);

  // ── Interval lifecycle ───────────────────────────────────────────

  useEffect(() => {
    if (!autopilotEnabled) return;

    // Run first tick immediately
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [autopilotEnabled, tick]);

  // ── Attack mode cleanup (UI concern) ─────────────────────────────

  useEffect(() => {
    if (attackMode === 'autopilot') {
      setSelectedBeasts([]);
      setAppliedExtraLifePotions(0);
    }
    if (attackMode !== 'autopilot' && autopilotEnabled) {
      setAutopilotEnabled(false);
      poisonedTokenIdRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attackMode]);

  // ── Public API (called by ActionBar for manual use too) ──────────

  const handleApplyExtraLife = async (amount: number) => {
    if (!summit?.beast || !isSavage || applyingPotions || amount === 0 || executingRef.current) return;
    executingRef.current = true;
    try {
      await doApplyExtraLife(summit.beast.token_id, amount);
    } finally {
      executingRef.current = false;
    }
  };

  const handleApplyPoison = async (amount: number, beastId?: number): Promise<boolean> => {
    const targetId = beastId ?? summit?.beast?.token_id;
    if (!targetId || applyingPotions || amount === 0 || executingRef.current) return false;
    executingRef.current = true;
    try {
      return await doApplyPoison(targetId, amount);
    } finally {
      executingRef.current = false;
    }
  };

  const startAutopilot = () => {
    setRevivePotionsUsed(() => 0);
    setAttackPotionsUsed(() => 0);
    setExtraLifePotionsUsed(() => 0);
    setPoisonPotionsUsed(() => 0);
    setAutopilotEnabled(true);
  };

  const stopAutopilot = () => {
    clearAttackTimeout();
    setAutopilotEnabled(false);
  };

  return {
    collectionWithCombat,
    isSavage,
    enableAttack,
    revivalPotionsRequired,
    autopilotLog,
    startAutopilot,
    stopAutopilot,
    handleApplyExtraLife,
    handleApplyPoison,
  };
}

// ── Helper: compute inter-batch poison amount ────────────────────────

function getInterBatchPoisonAmount(
  summit: NonNullable<ReturnType<typeof useGameStore.getState>['summit']>,
  ap: ReturnType<typeof useAutopilotStore.getState>,
  balances: Record<string, number>,
): number {
  const remainingCap = Math.max(0, ap.poisonTotalMax - ap.poisonPotionsUsed);
  const pb = balances?.["POISON"] || 0;

  if (ap.targetedPoisonBeasts.length > 0 && isBeastTargetedForPoison(summit.beast.token_id, ap.targetedPoisonBeasts)) {
    const beastAmount = getTargetedBeastPoisonAmount(summit.beast.token_id, ap.targetedPoisonBeasts);
    return Math.min(beastAmount, pb, remainingCap);
  }

  if (ap.targetedPoisonPlayers.length > 0 && isOwnerTargetedForPoison(summit.owner, ap.targetedPoisonPlayers)) {
    const playerAmount = getTargetedPoisonAmount(summit.owner, ap.targetedPoisonPlayers);
    return Math.min(playerAmount, pb, remainingCap);
  }

  return 0;
}
