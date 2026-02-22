#!/usr/bin/env node
/**
 * Backfill Market Logs with $SURVIVOR Cost
 *
 * Fetches potion Transfer events and $SURVIVOR Transfer events from the Starknet
 * RPC for the block range where market logs are missing, then inserts the missing
 * "Bought Potions" / "Sold Potions" summit_log rows with survivor_cost.
 *
 * This avoids a full reindex by only querying the specific events we need.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/backfill-market-survivor-cost.ts
 *   DATABASE_URL=postgres://... tsx scripts/backfill-market-survivor-cost.ts --dry-run
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_10";

// Contract addresses
const POTION_TOKENS: Record<string, string> = {
  "0x016dea82a6588ca9fb7200125fa05631b1c1735a313e24afe9c90301e441a796": "EXTRA LIFE",
  "0x016f9def00daef9f1874dd932b081096f50aec2fe61df31a81bc5707a7522443": "ATTACK",
  "0x029023e0a455d19d6887bc13727356070089527b79e6feb562ffe1afd6711dbe": "REVIVE",
  "0x049eaed2a1ba2f2eb6ac2661ffd2d79231cdd7d5293d9448df49c5986c9897ae": "POISON",
};
const SURVIVOR_TOKEN = "0x042dd777885ad2c116be96d4d634abc90a26a790ffb5871e037dd5ae7d2ec86b";
const EKUBO_CORE = "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b";

// Transfer selector: sn_keccak("Transfer")
const TRANSFER_SELECTOR = "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";

function feltToHex(felt: string): string {
  return "0x" + BigInt(felt).toString(16).padStart(64, "0");
}

function addressToBigInt(address: string): bigint {
  return BigInt(address);
}

const ekuboBigInt = addressToBigInt(EKUBO_CORE);

interface TransferEvent {
  transaction_hash: string;
  block_number: number;
  block_timestamp: string;
  contract_address: string;
  from: string;
  to: string;
  amount: number; // token units (may be fractional for $SURVIVOR)
  event_index: number;
}

async function rpcCall(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function getEvents(
  address: string,
  fromBlock: number,
  toBlock: number,
  continuationToken?: string,
): Promise<{ events: Array<{
  transaction_hash: string;
  block_number: number;
  keys: string[];
  data: string[];
  event_index: number;
}>; continuation_token?: string }> {
  const filter: Record<string, unknown> = {
    from_block: { block_number: fromBlock },
    to_block: { block_number: toBlock },
    address,
    keys: [[TRANSFER_SELECTOR]],
    chunk_size: 1000,
  };
  if (continuationToken) {
    filter.continuation_token = continuationToken;
  }
  const result = (await rpcCall("starknet_getEvents", { filter })) as {
    events: Array<{
      transaction_hash: string;
      block_number: number;
      keys: string[];
      data: string[];
    }>;
    continuation_token?: string;
  };

  // starknet_getEvents doesn't return event_index directly, but events
  // within a transaction are returned in order. We'll assign indices later.
  return {
    events: result.events.map((e, i) => ({ ...e, event_index: i })),
    continuation_token: result.continuation_token,
  };
}

async function getAllEvents(address: string, fromBlock: number, toBlock: number): Promise<Array<{
  transaction_hash: string;
  block_number: number;
  keys: string[];
  data: string[];
  event_index: number;
}>> {
  const allEvents: Array<{
    transaction_hash: string;
    block_number: number;
    keys: string[];
    data: string[];
    event_index: number;
  }> = [];
  let token: string | undefined;
  do {
    const result = await getEvents(address, fromBlock, toBlock, token);
    allEvents.push(...result.events);
    token = result.continuation_token;
  } while (token);
  return allEvents;
}

async function getBlockTimestamp(blockNumber: number): Promise<Date> {
  const result = (await rpcCall("starknet_getBlockWithTxHashes", {
    block_id: { block_number: blockNumber },
  })) as { timestamp: number };
  return new Date(result.timestamp * 1000);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // 1. Find what market logs already exist (and track which have zero survivor_cost)
    const existingRes = await client.query(
      `SELECT id, transaction_hash, sub_category, (data->>'token')::text as token,
              (data->>'survivor_cost')::numeric as survivor_cost
       FROM summit_log
       WHERE sub_category IN ('Bought Potions', 'Sold Potions')`
    );
    const existingTxKeys = new Set(
      existingRes.rows.map((r: { transaction_hash: string; token: string; sub_category: string }) =>
        `${r.transaction_hash}:${r.token}:${r.sub_category}`)
    );
    // Track rows that need survivor_cost updates (existing rows with cost = 0)
    const zeroCostRows = new Map<string, string>(); // txKey -> row id
    for (const r of existingRes.rows as Array<{ id: string; transaction_hash: string; token: string; sub_category: string; survivor_cost: number }>) {
      if (Number(r.survivor_cost) === 0) {
        zeroCostRows.set(`${r.transaction_hash}:${r.token}:${r.sub_category}`, r.id);
      }
    }
    console.log(`[Backfill] ${existingRes.rows.length} market logs already exist (${zeroCostRows.size} with zero survivor_cost)`);

    // 2. Determine block range to scan
    // Use the full range where market events could exist
    const rangeRes = await client.query(
      `SELECT MAX(block_number) as max_block FROM summit_log`
    );
    const maxBlock = Number(rangeRes.rows[0].max_block);
    // Scan from the indexer's starting block to catch all historical market events
    const fromBlock = 6_866_000;
    const toBlock = maxBlock;
    console.log(`[Backfill] Scanning blocks ${fromBlock} to ${toBlock}`);

    // 3. Fetch Transfer events for all potion tokens
    console.log(`[Backfill] Fetching potion Transfer events from RPC...`);
    const potionTransfers: TransferEvent[] = [];
    for (const [address, tokenName] of Object.entries(POTION_TOKENS)) {
      const events = await getAllEvents(address, fromBlock, toBlock);
      console.log(`  ${tokenName}: ${events.length} Transfer events`);
      for (const e of events) {
        const from = feltToHex(e.keys[1]);
        const to = feltToHex(e.keys[2]);
        const amountLow = BigInt(e.data[0]);
        const amountHigh = BigInt(e.data[1] ?? "0x0");
        const amount = amountLow + (amountHigh * (2n ** 128n));
        const wholeUnits = Number(amount / 1_000_000_000_000_000_000n);
        if (wholeUnits === 0) continue;
        potionTransfers.push({
          transaction_hash: e.transaction_hash,
          block_number: e.block_number,
          block_timestamp: "", // filled later
          contract_address: address,
          from, to,
          amount: wholeUnits,
          event_index: e.event_index,
        });
      }
    }
    console.log(`[Backfill] ${potionTransfers.length} non-zero potion transfers total`);

    // 4. Fetch $SURVIVOR Transfer events — only track inflows to Ekubo Core (pool revenue)
    console.log(`[Backfill] Fetching $SURVIVOR Transfer events from RPC...`);
    const survivorEvents = await getAllEvents(SURVIVOR_TOKEN, fromBlock, toBlock);
    console.log(`  $SURVIVOR: ${survivorEvents.length} Transfer events`);

    // Sum $SURVIVOR inflow to Ekubo Core per transaction
    const survivorInflowByTx = new Map<string, number>();
    for (const e of survivorEvents) {
      const to = feltToHex(e.keys[1 + 1]); // keys[2] = recipient
      if (addressToBigInt(to) !== ekuboBigInt) continue;
      const amountLow = BigInt(e.data[0]);
      const amountHigh = BigInt(e.data[1] ?? "0x0");
      const amount = amountLow + (amountHigh * (2n ** 128n));
      const units = Number(amount) / 1e18;
      if (units === 0) continue;
      survivorInflowByTx.set(e.transaction_hash, (survivorInflowByTx.get(e.transaction_hash) || 0) + units);
    }
    console.log(`  Transactions with $SURVIVOR -> Ekubo: ${survivorInflowByTx.size}`);

    // 5. Group potion transfers by (transaction_hash, token) — same logic as indexer
    const txTokenMap = new Map<string, { tokenName: string; transfers: TransferEvent[] }>();
    for (const t of potionTransfers) {
      const tokenName = POTION_TOKENS[t.contract_address];
      const key = `${t.transaction_hash}:${tokenName}`;
      if (!txTokenMap.has(key)) {
        txTokenMap.set(key, { tokenName, transfers: [] });
      }
      txTokenMap.get(key)!.transfers.push(t);
    }

    // 6. Resolve market events (same algorithm as indexer)
    const isExcluded = (addr: bigint) => addr === 0n || addr === ekuboBigInt;

    interface MarketLogRow {
      block_number: number;
      event_index: number;
      sub_category: string;
      token: string;
      player: string;
      amount: number;
      survivor_cost: number;
      transaction_hash: string;
    }

    const newRows: MarketLogRow[] = [];
    const updateRows: Array<{ id: string; survivor_cost: number }> = [];
    // Use a high offset for event_index to avoid collisions with existing rows
    // (real event indices from the indexer are typically < 1000)
    let backfillEventIndex = 50000;

    // Cache for block timestamps
    const blockTimestamps = new Map<number, Date>();

    for (const [, { tokenName, transfers }] of txTokenMap) {
      // Check Ekubo involvement
      const involvesEkubo = transfers.some(t => {
        const fromBig = addressToBigInt(t.from);
        const toBig = addressToBigInt(t.to);
        return fromBig === ekuboBigInt || toBig === ekuboBigInt;
      });
      if (!involvesEkubo) continue;

      // Compute net flow per address (exclude zero addr and Ekubo Core)
      const netFlow = new Map<string, number>();
      for (const t of transfers) {
        const fromBig = addressToBigInt(t.from);
        const toBig = addressToBigInt(t.to);
        if (!isExcluded(toBig)) {
          netFlow.set(t.to, (netFlow.get(t.to) || 0) + t.amount);
        }
        if (!isExcluded(fromBig)) {
          netFlow.set(t.from, (netFlow.get(t.from) || 0) - t.amount);
        }
      }

      // $SURVIVOR inflow to Ekubo Core = price paid for potions in this tx
      const first = transfers[0];
      const survivorInflow = survivorInflowByTx.get(first.transaction_hash) || 0;

      for (const [address, net] of netFlow) {
        if (net === 0) continue;

        const isBuy = net > 0;
        const subCategory = isBuy ? "Bought Potions" : "Sold Potions";
        const txKey = `${first.transaction_hash}:${tokenName}:${subCategory}`;
        const survivorCost = Math.round(survivorInflow * 1e4) / 1e4;

        // Check if this row already exists with zero cost — if so, queue an update
        const existingId = zeroCostRows.get(txKey);
        if (existingId && survivorCost > 0) {
          updateRows.push({ id: existingId, survivor_cost: survivorCost });
          continue;
        }

        // Skip if already exists (with non-zero cost)
        if (existingTxKeys.has(txKey)) continue;

        newRows.push({
          block_number: first.block_number,
          event_index: backfillEventIndex++,
          sub_category: subCategory,
          token: tokenName,
          player: address,
          amount: Math.abs(net),
          survivor_cost: survivorCost,
          transaction_hash: first.transaction_hash,
        });
      }
    }

    console.log(`\n[Backfill] ${newRows.length} new market log rows to insert`);
    console.log(`[Backfill] ${updateRows.length} existing rows to update with survivor_cost`);
    if (newRows.length === 0 && updateRows.length === 0) {
      console.log("[Backfill] Nothing to do.");
      return;
    }

    // Show samples
    if (newRows.length > 0) {
      console.log("[Backfill] Sample new rows:");
      for (const row of newRows.slice(0, 3)) {
        console.log(`  ${row.sub_category}: ${row.amount} ${row.token} @ ${row.survivor_cost} $SURVIVOR (block ${row.block_number})`);
      }
    }
    if (updateRows.length > 0) {
      console.log("[Backfill] Sample updates:");
      for (const row of updateRows.slice(0, 3)) {
        console.log(`  id=${row.id} -> survivor_cost=${row.survivor_cost}`);
      }
    }

    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would insert ${newRows.length} rows and update ${updateRows.length} rows. Re-run without --dry-run to execute.`);
      return;
    }

    // 7. Fetch block timestamps and insert new rows
    if (newRows.length > 0) {
      console.log(`[Backfill] Fetching block timestamps...`);
      const uniqueBlocks = [...new Set(newRows.map(r => r.block_number))];
      for (const bn of uniqueBlocks) {
        if (!blockTimestamps.has(bn)) {
          blockTimestamps.set(bn, await getBlockTimestamp(bn));
        }
      }

      console.log(`[Backfill] Inserting ${newRows.length} rows...`);
      const now = new Date();
      let inserted = 0;
      for (const row of newRows) {
        const blockTs = blockTimestamps.get(row.block_number) || now;
        try {
          await client.query(
            `INSERT INTO summit_log (block_number, event_index, category, sub_category, data, player, token_id, transaction_hash, created_at, indexed_at)
             VALUES ($1, $2, 'Market', $3, $4, $5, NULL, $6, $7, $8)
             ON CONFLICT (block_number, transaction_hash, event_index) DO NOTHING`,
            [
              row.block_number,
              row.event_index,
              row.sub_category,
              JSON.stringify({
                player: row.player,
                token: row.token,
                amount: row.amount,
                survivor_cost: row.survivor_cost,
              }),
              row.player,
              row.transaction_hash,
              blockTs,
              now,
            ]
          );
          inserted++;
        } catch (err) {
          console.error(`  Failed to insert row for tx ${row.transaction_hash}:`, (err as Error).message);
        }
      }
      console.log(`[Backfill] Inserted ${inserted} rows.`);
    }

    // 8. Update existing rows that had zero survivor_cost
    if (updateRows.length > 0) {
      console.log(`[Backfill] Updating ${updateRows.length} existing rows with survivor_cost...`);
      let updated = 0;
      for (const row of updateRows) {
        try {
          await client.query(
            `UPDATE summit_log
             SET data = jsonb_set(data, '{survivor_cost}', $1::jsonb)
             WHERE id = $2`,
            [JSON.stringify(row.survivor_cost), row.id]
          );
          updated++;
        } catch (err) {
          console.error(`  Failed to update row ${row.id}:`, (err as Error).message);
        }
      }
      console.log(`[Backfill] Updated ${updated} rows.`);
    }

    console.log(`\n[Backfill] Done.`);

    // Final count
    const finalRes = await client.query(
      `SELECT sub_category, COUNT(*) as cnt FROM summit_log WHERE sub_category IN ('Bought Potions', 'Sold Potions') GROUP BY sub_category`
    );
    console.log("[Backfill] Final market log counts:");
    for (const r of finalRes.rows) {
      console.log(`  ${r.sub_category}: ${r.cnt}`);
    }

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
