#!/usr/bin/env node
/**
 * Reindex Market Logs
 *
 * Deletes existing "Bought Potions" / "Sold Potions" summit_log rows and resets
 * the Apibara checkpoint so the indexer re-processes from the starting block.
 * This allows the new $SURVIVOR cost tracking to backfill all historical trades.
 *
 * All other data (beast_stats, battles, ownership, consumables, etc.) is
 * unaffected thanks to idempotent upserts / onConflictDoNothing.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/reindex-market-logs.ts
 *   DATABASE_URL=postgres://... tsx scripts/reindex-market-logs.ts --dry-run
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const INDEXER_NAME = "summit";

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    if (DRY_RUN) {
      console.log("[DRY RUN] No changes will be made.\n");
    }

    // 1. Show current checkpoint
    const checkpoint = await client.query(
      `SELECT id, order_key, unique_key FROM airfoil.checkpoints WHERE id = $1`,
      [INDEXER_NAME]
    );
    if (checkpoint.rows.length > 0) {
      const row = checkpoint.rows[0];
      console.log(`[Checkpoint] Current: block ${row.order_key} (unique_key: ${row.unique_key})`);
    } else {
      console.log("[Checkpoint] No checkpoint found — indexer will start fresh.");
    }

    // 2. Count market log rows that will be deleted
    const countResult = await client.query(
      `SELECT sub_category, COUNT(*) as cnt
       FROM summit_log
       WHERE sub_category IN ('Bought Potions', 'Sold Potions')
       GROUP BY sub_category
       ORDER BY sub_category`
    );
    if (countResult.rows.length === 0) {
      console.log("[Market Logs] No market log rows found — nothing to delete.");
    } else {
      for (const row of countResult.rows) {
        console.log(`[Market Logs] ${row.sub_category}: ${row.cnt} rows`);
      }
    }

    if (DRY_RUN) {
      console.log("\n[DRY RUN] Would delete market log rows and reset checkpoint. Re-run without --dry-run to execute.");
      return;
    }

    // 3. Delete market log rows
    const deleteResult = await client.query(
      `DELETE FROM summit_log WHERE sub_category IN ('Bought Potions', 'Sold Potions')`
    );
    console.log(`\n[Deleted] ${deleteResult.rowCount} market log rows`);

    // 4. Reset checkpoint so the indexer re-processes from its configured startingBlock
    const resetResult = await client.query(
      `DELETE FROM airfoil.checkpoints WHERE id = $1`,
      [INDEXER_NAME]
    );
    if (resetResult.rowCount && resetResult.rowCount > 0) {
      console.log(`[Checkpoint] Reset — indexer will re-sync from startingBlock on next run`);
    } else {
      console.log("[Checkpoint] No checkpoint to reset");
    }

    // 5. Clean up reorg rollback entries (stale after checkpoint reset)
    try {
      const reorgResult = await client.query(
        `DELETE FROM airfoil.reorg_rollback WHERE indexer_name = $1`,
        [INDEXER_NAME]
      );
      if (reorgResult.rowCount && reorgResult.rowCount > 0) {
        console.log(`[Reorg] Cleaned up ${reorgResult.rowCount} reorg_rollback entries`);
      }
    } catch {
      // Table may not exist — that's fine
    }

    console.log("\nDone. Start the indexer to begin re-indexing from the starting block.");

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
