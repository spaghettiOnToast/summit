import { useController } from '@/contexts/controller';
import { MAX_BEASTS_PER_ATTACK, useGameDirector } from '@/contexts/GameDirector';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { useGameStore } from '@/stores/gameStore';
import type { Beast } from '@/types/game';
import { delay } from '@/utils/utils';
import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  calculateRevivalRequired,
  isOwnerIgnored, isOwnerTargetedForPoison, getTargetedPoisonAmount,
  isBeastTargetedForPoison, getTargetedBeastPoisonAmount,
  hasDiplomacyMatch, selectOptimalBeasts,
} from '../utils/beasts';

export function useAutopilotOrchestrator() {
  const { executeGameAction } = useGameDirector();
  const { tokenBalances } = useController();

  const { selectedBeasts, summit,
    attackInProgress,
    applyingPotions, setApplyingPotions, setBattleEvents, setAttackInProgress,
    collection, setSelectedBeasts, attackMode, autopilotLog, setAutopilotLog,
    autopilotEnabled, setAutopilotEnabled, setAppliedExtraLifePotions } = useGameStore();
  const {
    attackStrategy,
    extraLifeStrategy,
    extraLifeMax,
    extraLifeTotalMax,
    extraLifeReplenishTo,
    extraLifePotionsUsed,
    useRevivePotions,
    revivePotionMax,
    revivePotionMaxPerBeast,
    useAttackPotions,
    attackPotionMax,
    attackPotionMaxPerBeast,
    revivePotionsUsed,
    attackPotionsUsed,
    setRevivePotionsUsed,
    setAttackPotionsUsed,
    setExtraLifePotionsUsed,
    setPoisonPotionsUsed,
    poisonStrategy,
    poisonTotalMax,
    poisonPotionsUsed,
    poisonConservativeExtraLivesTrigger,
    poisonConservativeAmount,
    poisonAggressiveAmount,
    poisonMinPower,
    poisonMinHealth,
    maxBeastsPerAttack,
    skipSharedDiplomacy,
    ignoredPlayers,
    targetedPoisonPlayers,
    targetedPoisonBeasts,
    questMode,
    questFilters,
  } = useAutopilotStore();

  const [triggerAutopilot, setTriggerAutopilot] = useReducer((x: number) => x + 1, 0);
  const poisonedTokenIdRef = React.useRef<number | null>(null);
  const attackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attackingRef = useRef(false);
  const executingRef = useRef(false); // Global lock to prevent concurrent wallet calls
  const cooldownUntilRef = useRef(0);
  const lastSummitBeastRef = useRef<number | null>(null);

  // Delay between sequential wallet calls to let the controller settle
  const TX_SETTLE_MS = 3_000;

  // Cooldown after failures to prevent rapid-fire retries
  const COOLDOWN_MS = 30_000; // 30 seconds before retrying after a failure

  const setCooldown = useCallback(() => {
    cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
    console.log(`[Autopilot] Cooldown set for ${COOLDOWN_MS / 1000}s`);
  }, []);

  const isOnCooldown = useCallback(() => {
    return Date.now() < cooldownUntilRef.current;
  }, []);

  // Safety timeout: force-clear attackInProgress if wallet hangs
  const ATTACK_TIMEOUT_MS = 90_000; // 90 seconds (wallet has its own 60s timeout)

  const startAttackTimeout = useCallback(() => {
    if (attackTimeoutRef.current) clearTimeout(attackTimeoutRef.current);
    attackTimeoutRef.current = setTimeout(() => {
      const { attackInProgress: stillAttacking } = useGameStore.getState();
      if (stillAttacking) {
        console.warn('[Autopilot] Attack timed out after 90s — force-clearing attackInProgress');
        setAttackInProgress(false);
      }
      setCooldown();
      attackTimeoutRef.current = null;
    }, ATTACK_TIMEOUT_MS);
  }, [setAttackInProgress, setCooldown]);

  const clearAttackTimeout = useCallback(() => {
    if (attackTimeoutRef.current) {
      clearTimeout(attackTimeoutRef.current);
      attackTimeoutRef.current = null;
    }
  }, []);

  const isSavage = Boolean(collection.find(beast => beast.token_id === summit?.beast?.token_id));
  const revivalPotionsRequired = calculateRevivalRequired(selectedBeasts);
  const hasEnoughRevivePotions = (tokenBalances["REVIVE"] || 0) >= revivalPotionsRequired;
  const enableAttack = (attackMode === 'autopilot' && !attackInProgress) || ((!isSavage || attackMode !== 'safe') && summit?.beast && !attackInProgress && selectedBeasts.length > 0 && hasEnoughRevivePotions);

  // ── Beast selection ──────────────────────────────────────────────────

  const collectionWithCombat = useMemo<Beast[]>(() => {
    if (summit && collection.length > 0) {
      return selectOptimalBeasts(collection, summit, {
        useRevivePotions,
        revivePotionMax,
        revivePotionMaxPerBeast,
        revivePotionsUsed,
        useAttackPotions,
        attackPotionMax,
        attackPotionMaxPerBeast,
        attackPotionsUsed,
        autopilotEnabled,
        questMode,
        questFilters,
      });
    }

    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summit?.beast?.token_id, summit?.beast?.extra_lives, summit?.beast?.current_health, collection.length, revivePotionsUsed, attackPotionsUsed, useRevivePotions, useAttackPotions, questMode, questFilters, maxBeastsPerAttack, attackStrategy, autopilotEnabled]);

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleApplyExtraLife = async (amount: number) => {
    if (!summit?.beast || !isSavage || applyingPotions || amount === 0 || executingRef.current) return;

    executingRef.current = true;
    setApplyingPotions(true);
    setAutopilotLog('Adding extra lives...');

    try {
      const result = await executeGameAction({
        type: 'add_extra_life',
        beastId: summit.beast.token_id,
        extraLifePotions: amount,
      });
      if (!result) setCooldown();
    } finally {
      await delay(TX_SETTLE_MS);
      executingRef.current = false;
      setTriggerAutopilot(); // Re-trigger effect since ref change won't cause re-render
    }
  };

  const handleApplyPoison = async (amount: number, beastId?: number): Promise<boolean> => {
    const targetId = beastId ?? summit?.beast?.token_id;
    if (!targetId || applyingPotions || amount === 0 || executingRef.current) return false;

    executingRef.current = true;
    setApplyingPotions(true);
    setAutopilotLog('Applying poison...');

    try {
      const result = await executeGameAction({
        type: 'apply_poison',
        beastId: targetId,
        count: amount,
      });
      if (!result) setCooldown();
      return !!result;
    } finally {
      await delay(TX_SETTLE_MS);
      executingRef.current = false;
      setTriggerAutopilot();
    }
  };

  const handleAttackUntilCapture = async (extraLifePotions: number) => {
    const { attackInProgress: alreadyAttacking, applyingPotions: alreadyApplying } = useGameStore.getState();
    if (!enableAttack || alreadyAttacking || alreadyApplying || attackingRef.current || executingRef.current || isOnCooldown()) return;

    attackingRef.current = true;
    executingRef.current = true;
    setBattleEvents([]);
    setAttackInProgress(true);
    startAttackTimeout();

    try {
      const allBeasts: [Beast, number, number][] = collectionWithCombat.map((beast: Beast) => [beast, 1, beast.combat?.attackPotions || 0]);

      const batches: [Beast, number, number][][] = [];
      for (let i = 0; i < allBeasts.length; i += MAX_BEASTS_PER_ATTACK) {
        batches.push(allBeasts.slice(i, i + MAX_BEASTS_PER_ATTACK));
      }

      const poisonedThisSequence = new Set<number>();

      for (const batch of batches) {
        // Between batches: check if summit changed to an ignored or diplomacy-matched player
        const currentSummit = useGameStore.getState().summit;
        if (currentSummit) {
          const { ignoredPlayers: ig, skipSharedDiplomacy: skipDip, targetedPoisonPlayers: tpp } = useAutopilotStore.getState();
          const currentCollection = useGameStore.getState().collection;
          const isMyBeast = currentCollection.some((b: Beast) => b.token_id === currentSummit.beast.token_id);

          if (isMyBeast) {
            setAutopilotLog('Summit captured — halting attack');
            break;
          }
          if (isOwnerIgnored(currentSummit.owner, ig)) {
            setAutopilotLog('Halted: ignored player took summit');
            break;
          }
          if (skipDip && hasDiplomacyMatch(currentCollection, currentSummit.beast)) {
            setAutopilotLog('Halted: shared diplomacy');
            break;
          }

          // Fire targeted poison between batches (once per target per sequence)
          // Release executingRef so handleApplyPoison can acquire it, then re-acquire
          if (!poisonedThisSequence.has(currentSummit.beast.token_id)) {
            const { poisonTotalMax: ptm, poisonPotionsUsed: ppu, targetedPoisonBeasts: tpb } = useAutopilotStore.getState();
            let poisonAmount = 0;
            let poisonTarget = currentSummit.beast.token_id;

            const isBeastTarget = tpb.length > 0 && isBeastTargetedForPoison(currentSummit.beast.token_id, tpb);
            if (isBeastTarget) {
              const beastAmount = getTargetedBeastPoisonAmount(currentSummit.beast.token_id, tpb);
              const remainingCap = Math.max(0, ptm - ppu);
              const pb = tokenBalances?.["POISON"] || 0;
              poisonAmount = Math.min(beastAmount, pb, remainingCap);
            } else if (tpp.length > 0 && isOwnerTargetedForPoison(currentSummit.owner, tpp)) {
              const playerAmount = getTargetedPoisonAmount(currentSummit.owner, tpp);
              const remainingCap = Math.max(0, ptm - ppu);
              const pb = tokenBalances?.["POISON"] || 0;
              poisonAmount = Math.min(playerAmount, pb, remainingCap);
            }

            if (poisonAmount > 0) {
              executingRef.current = false; // Release lock for poison call
              await handleApplyPoison(poisonAmount, poisonTarget);
              await delay(TX_SETTLE_MS);
              executingRef.current = true; // Re-acquire for next batch
              poisonedThisSequence.add(currentSummit.beast.token_id);
            }
          }
        }

        // Let the controller settle between batches
        if (batches.indexOf(batch) > 0) {
          await delay(TX_SETTLE_MS);
        }

        const result = await executeGameAction({
          type: 'attack_until_capture',
          beasts: batch,
          extraLifePotions
        });

        if (!result) {
          // result is false for both capture (expected) and failure
          // Check if we captured by seeing if our beast is now on summit
          const postSummit = useGameStore.getState().summit;
          const postCollection = useGameStore.getState().collection;
          const didCapture = postSummit && postCollection.some((b: Beast) => b.token_id === postSummit.beast.token_id);
          if (!didCapture) setCooldown();
          break;
        }
      }
    } catch (error) {
      console.error('[Autopilot] all_out attack error:', error);
      setCooldown();
    } finally {
      attackingRef.current = false;
      clearAttackTimeout();
      setAttackInProgress(false);
      await delay(TX_SETTLE_MS);
      executingRef.current = false;
      setTriggerAutopilot();
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

  // ── Effects ──────────────────────────────────────────────────────────

  // Reset state when attack mode changes
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

  // Diplomacy / ignored player memos
  const summitSharesDiplomacy = useMemo(() => {
    if (!skipSharedDiplomacy || !summit?.beast) return false;
    return collection.some(
      (beast: Beast) =>
        beast.diplomacy &&
        beast.prefix === summit.beast.prefix &&
        beast.suffix === summit.beast.suffix,
    );
  }, [skipSharedDiplomacy, summit?.beast?.token_id, collection.length]);

  const summitOwnerIgnored = useMemo(() => {
    if (ignoredPlayers.length === 0 || !summit?.owner) return false;
    const ownerNormalized = summit.owner.replace(/^0x0+/, '0x').toLowerCase();
    return ignoredPlayers.some((p) => p.address === ownerNormalized);
  }, [ignoredPlayers, summit?.owner]);

  const shouldSkipSummit = summitSharesDiplomacy || summitOwnerIgnored;

  // Autopilot status log
  useEffect(() => {
    if (autopilotEnabled && !attackInProgress && !applyingPotions) {
      if (summitSharesDiplomacy) {
        setAutopilotLog('Ignoring shared diplomacy');
      } else if (summitOwnerIgnored) {
        const owner = summit?.owner?.replace(/^0x0+/, '0x').toLowerCase();
        const player = ignoredPlayers.find((p) => p.address === owner);
        setAutopilotLog(`Ignoring ${player?.name ?? 'player'}`);
      } else {
        setAutopilotLog('Waiting for trigger...');
      }
    } else if (attackInProgress) {
      setAutopilotLog('Attacking...');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilotEnabled, attackInProgress, applyingPotions, summitSharesDiplomacy, summitOwnerIgnored]);

  // Targeted + aggressive poison on summit change or config change
  useEffect(() => {
    if (!autopilotEnabled || !summit?.beast) return;

    const { attackInProgress: attacking, applyingPotions: applying } = useGameStore.getState();
    if (attacking || applying || executingRef.current) return;

    const myBeast = collection.find((beast: Beast) => beast.token_id === summit.beast.token_id);
    if (myBeast) return;

    // Beast-level targeted poison (highest priority)
    const isBeastTarget = targetedPoisonBeasts.length > 0 && isBeastTargetedForPoison(summit.beast.token_id, targetedPoisonBeasts);
    if (isBeastTarget) {
      const beastAmount = getTargetedBeastPoisonAmount(summit.beast.token_id, targetedPoisonBeasts);
      const remainingCap = Math.max(0, poisonTotalMax - poisonPotionsUsed);
      const pb = tokenBalances?.["POISON"] || 0;
      const amount = Math.min(beastAmount, pb, remainingCap);
      if (amount > 0) handleApplyPoison(amount, summit.beast.token_id);
      return;
    }

    // Player-level targeted poison
    const isTargeted = targetedPoisonPlayers.length > 0 && isOwnerTargetedForPoison(summit.owner, targetedPoisonPlayers);
    if (isTargeted) {
      const playerAmount = getTargetedPoisonAmount(summit.owner, targetedPoisonPlayers);
      const remainingCap = Math.max(0, poisonTotalMax - poisonPotionsUsed);
      const pb = tokenBalances?.["POISON"] || 0;
      const amount = Math.min(playerAmount, pb, remainingCap);
      if (amount > 0) handleApplyPoison(amount, summit.beast.token_id);
      return;
    }

    if (poisonStrategy !== 'aggressive') return;
    if (shouldSkipSummit) return;

    // Reset tracked token when summit beast changes
    if (poisonedTokenIdRef.current !== summit.beast.token_id) {
      poisonedTokenIdRef.current = null;
    }
    if (poisonedTokenIdRef.current === summit.beast.token_id) return;

    if (poisonMinPower > 0 && summit.beast.power < poisonMinPower) return;
    if (poisonMinHealth > 0 && summit.beast.current_health < poisonMinHealth) return;

    const remainingCap = Math.max(0, poisonTotalMax - poisonPotionsUsed);
    const pb = tokenBalances?.["POISON"] || 0;
    const amount = Math.min(poisonAggressiveAmount, pb, remainingCap);
    if (amount > 0) {
      handleApplyPoison(amount, summit.beast.token_id).then((fired) => {
        if (fired) poisonedTokenIdRef.current = summit.beast.token_id;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summit?.beast?.token_id, autopilotEnabled, targetedPoisonPlayers, targetedPoisonBeasts, poisonTotalMax]);

  // Clear cooldown when summit beast changes (new target = fresh attempt)
  useEffect(() => {
    if (summit?.beast?.token_id && summit.beast.token_id !== lastSummitBeastRef.current) {
      lastSummitBeastRef.current = summit.beast.token_id;
      cooldownUntilRef.current = 0;
    }
  }, [summit?.beast?.token_id]);

  // Main autopilot attack + conservative poison + extra life logic
  useEffect(() => {
    if (!autopilotEnabled || attackInProgress || applyingPotions || !summit || executingRef.current) {
      if (autopilotEnabled) {
        console.log('[Autopilot] Blocked:', { attackInProgress, applyingPotions, executing: executingRef.current, hasSummit: !!summit });
      }
      return;
    }

    if (isOnCooldown()) {
      const remaining = Math.ceil((cooldownUntilRef.current - Date.now()) / 1000);
      setAutopilotLog(`Cooldown: ${remaining}s`);
      return;
    }

    if (!collectionWithCombat || collectionWithCombat.length === 0) {
      const msg = 'No eligible beasts available';
      console.log('[Autopilot]', msg, { revivePotionsUsed, revivePotionMax, attackPotionsUsed, attackPotionMax, collectionSize: collection.length });
      setAutopilotLog(msg);
      return;
    }

    const myBeast = collection.find((beast: Beast) => beast.token_id === summit?.beast.token_id);

    if (myBeast) {
      if (extraLifeStrategy === 'aggressive' && myBeast.extra_lives >= 0 && myBeast.extra_lives < extraLifeReplenishTo) {
        const extraLifePotions = Math.min(extraLifeTotalMax - extraLifePotionsUsed, extraLifeReplenishTo - myBeast.extra_lives);
        if (extraLifePotions > 0) {
          handleApplyExtraLife(extraLifePotions);
        }
      }

      return;
    }

    if (shouldSkipSummit) return;

    // Conservative poison — if fired, wait for completion before attacking
    let poisonFired = false;
    if (poisonStrategy === 'conservative'
      && summit.beast.extra_lives >= poisonConservativeExtraLivesTrigger
      && summit.poison_count < poisonConservativeAmount
      && poisonedTokenIdRef.current !== summit.beast.token_id
      && (poisonMinPower <= 0 || summit.beast.power >= poisonMinPower)
      && (poisonMinHealth <= 0 || summit.beast.current_health >= poisonMinHealth)) {
      const remainingCap = Math.max(0, poisonTotalMax - poisonPotionsUsed);
      const poisonBalance = tokenBalances?.["POISON"] || 0;
      const amount = Math.min(poisonConservativeAmount - summit.poison_count, poisonBalance, remainingCap);
      if (amount > 0) {
        // handleApplyPoison is async but executingRef guards concurrency;
        // the effect will re-trigger via applyingPotions dep when it completes
        handleApplyPoison(amount);
        poisonedTokenIdRef.current = summit.beast.token_id;
        poisonFired = true;
      }
    }

    // If we just fired poison, applyingPotions is now true — wait for it
    // to complete before attacking (effect will re-trigger via applyingPotions dep)
    if (poisonFired) {
      console.log('[Autopilot] Conservative poison applied, deferring attack');
      return;
    }

    let extraLifePotions = 0;
    if (extraLifeStrategy === 'after_capture') {
      extraLifePotions = Math.min(extraLifeTotalMax - extraLifePotionsUsed, extraLifeMax);
    } else if (extraLifeStrategy === 'aggressive') {
      extraLifePotions = Math.min(extraLifeTotalMax - extraLifePotionsUsed, extraLifeReplenishTo);
    }

    if (attackStrategy === 'never') {
      setAutopilotLog('Attack strategy: never');
      return;
    } else if (attackStrategy === 'all_out') {
      console.log('[Autopilot] Firing all_out attack', { beasts: collectionWithCombat.length, extraLifePotions });
      handleAttackUntilCapture(extraLifePotions);
    } else if (attackStrategy === 'guaranteed') {
      const beasts = collectionWithCombat.slice(0, maxBeastsPerAttack);

      if (beasts.length === 0) {
        const msg = 'No beasts in range';
        console.log('[Autopilot]', msg);
        setAutopilotLog(msg);
        return;
      }

      const totalSummitHealth = ((summit.beast.health + summit.beast.bonus_health) * summit.beast.extra_lives) + summit.beast.current_health;
      const totalEstimatedDamage = beasts.reduce((acc, beast) => acc + (beast.combat?.estimatedDamage ?? 0), 0);
      if (totalEstimatedDamage < (totalSummitHealth * 1.1)) {
        const msg = `Damage insufficient: ${Math.floor(totalEstimatedDamage)} / ${Math.floor(totalSummitHealth * 1.1)} needed`;
        console.log('[Autopilot]', msg, { beasts: beasts.length, revivePotionsUsed, attackPotionsUsed });
        setAutopilotLog(msg);
        return;
      }

      if (attackingRef.current || executingRef.current) return;
      attackingRef.current = true;
      executingRef.current = true;

      const msg = `Attacking with ${beasts.length} beast${beasts.length > 1 ? 's' : ''}...`;
      console.log('[Autopilot]', msg, { extraLifePotions, attackPotions: beasts[0]?.combat?.attackPotions || 0 });
      setAutopilotLog(msg);
      startAttackTimeout();
      executeGameAction({
        type: 'attack',
        beasts: beasts.map((beast: Beast) => ([beast, 1, beast.combat?.attackPotions || 0])),
        safeAttack: false,
        vrf: true,
        extraLifePotions: extraLifePotions,
        attackPotions: beasts[0]?.combat?.attackPotions || 0
      }).then((success) => {
        clearAttackTimeout();
        if (!success) {
          setCooldown();
          setAttackInProgress(false);
        }
      }).catch((error) => {
        console.error('[Autopilot] guaranteed attack error:', error);
        setCooldown();
        clearAttackTimeout();
        setAttackInProgress(false);
      }).finally(async () => {
        attackingRef.current = false;
        await delay(TX_SETTLE_MS);
        executingRef.current = false;
        setTriggerAutopilot();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionWithCombat, autopilotEnabled, summit?.beast.extra_lives, triggerAutopilot, attackInProgress, applyingPotions]);

  // Re-trigger autopilot when summit beast is about to die (0 extra lives, 1 HP)
  useEffect(() => {
    if (autopilotEnabled && !attackInProgress && summit?.beast.extra_lives === 0 && summit?.beast.current_health === 1) {
      setTriggerAutopilot();
    }
  }, [autopilotEnabled, summit?.beast.current_health]);

  // ── Return values needed by ActionBar UI ─────────────────────────────

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
