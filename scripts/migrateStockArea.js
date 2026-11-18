/**
 * Migration: introduce the Store/Kitchen `area` dimension on stock.
 *
 * For every tenant DB:
 *   1. Stamp `area: 'kitchen'` on all existing StockItem rows (preserves current
 *      single-location behaviour — everything today is effectively the kitchen).
 *   2. Drop the legacy unique index { product, outlet } — REQUIRED, otherwise a
 *      store row and a kitchen row for the same product cannot coexist.
 *   3. Create the new unique index { product, outlet, area }.
 *
 * Safe to re-run (idempotent): steps skip when already applied.
 *
 * Usage:  node scripts/migrateStockArea.js
 */
import 'dotenv/config';
import { connectPlatform, getTenantConnectionFor } from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';
import logger from '../src/utils/logger.js';

const LEGACY_INDEX = 'product_1_outlet_1';

const migrateTenant = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  const col = conn.collection('stockitems');

  // 1. Stamp area on rows that predate the field.
  const stamp = await col.updateMany(
    { area: { $exists: false } },
    { $set: { area: 'kitchen' } },
  );

  // 2. Drop the legacy unique index if it still exists.
  let dropped = false;
  const indexes = await col.indexes();
  if (indexes.some((i) => i.name === LEGACY_INDEX)) {
    await col.dropIndex(LEGACY_INDEX);
    dropped = true;
  }

  // 3. Ensure the new composite unique index.
  await col.createIndex({ product: 1, outlet: 1, area: 1 }, { unique: true });

  logger.info(
    `[${slug}] stamped ${stamp.modifiedCount} row(s); legacy index ${dropped ? 'dropped' : 'absent'}; composite unique index ensured.`,
  );
  return conn;
};

const run = async () => {
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug').lean();
  logger.info(`Stock area migration: ${tenants.length} tenant(s).`);

  const conns = [];
  let ok = 0;
  let failed = 0;

  for (const t of tenants) {
    try {
      const conn = await migrateTenant(t.slug);
      conns.push(conn);
      ok += 1;
    } catch (err) {
      failed += 1;
      logger.error(`[${t.slug}] migration FAILED: ${err.message}`);
    }
  }

  logger.info(`Done. ${ok} succeeded, ${failed} failed.`);

  await Promise.allSettled(conns.map((c) => c.close()));
  const { getPlatformConnection } = await import('../src/db/connections.js');
  try { await getPlatformConnection().close(); } catch { /* noop */ }

  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  logger.error(`Migration crashed: ${err.message}`);
  process.exit(1);
});
