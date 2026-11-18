/**
 * Backfill the cancellation operating date for every voided sale.
 *
 * Dry-run (read only):
 *   node scripts/backfillCancelledOrderBusinessDates.js
 *
 * Apply (writes a recovery snapshot before changing data):
 *   node scripts/backfillCancelledOrderBusinessDates.js --apply --backup=../backups/cancelled-order-business-dates.json
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  connectPlatform,
  getPlatformConnection,
  getTenantConnectionFor,
} from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';
import { getBusinessDate } from '../src/utils/businessDate.js';

const APPLY = process.argv.includes('--apply');
const backupArg = process.argv.find((arg) => arg.startsWith('--backup='));
const backupFile = backupArg ? path.resolve(backupArg.slice('--backup='.length)) : null;

const cancellationInstant = (row) =>
  row.voidedAt || row.qrOrder?.declinedAt || row.updatedAt || row.createdAt || null;

const closeAll = async (connections) => {
  await Promise.allSettled(connections.map((conn) => conn.close()));
  try { await getPlatformConnection().close(); } catch { /* noop */ }
};

const run = async () => {
  if (APPLY && !backupFile) {
    throw new Error('Apply mode requires --backup=/absolute/or/relative/path.json');
  }

  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (no writes) ---');
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug name').sort({ slug: 1 }).lean();
  const connections = [];
  const snapshots = [];

  try {
    for (const tenant of tenants) {
      const conn = await getTenantConnectionFor(tenant.slug);
      connections.push(conn);
      const [outlets, rows] = await Promise.all([
        conn.collection('outlets').find(
          {},
          { projection: { name: 1, code: 1, timezone: 1, businessDayStart: 1, businessDayEnd: 1 } },
        ).toArray(),
        conn.collection('saletransactions').find(
          { status: 'void' },
          {
            projection: {
              transactionNumber: 1,
              outlet: 1,
              businessDate: 1,
              voidBusinessDate: 1,
              voidedAt: 1,
              'qrOrder.declinedAt': 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ).toArray(),
      ]);
      const outletsById = new Map(outlets.map((outlet) => [String(outlet._id), outlet]));
      const changes = [];
      const unresolved = [];

      for (const row of rows) {
        const outlet = outletsById.get(String(row.outlet));
        const instant = cancellationInstant(row);
        if (!outlet || !instant) {
          unresolved.push({
            _id: row._id,
            transactionNumber: row.transactionNumber,
            reason: !outlet ? 'missing outlet' : 'missing cancellation timestamp',
          });
          continue;
        }
        const timezone = outlet.timezone || 'Asia/Karachi';
        const start = outlet.businessDayStart || '00:00';
        const end = outlet.businessDayEnd || start;
        const expected = getBusinessDate(instant, timezone, start, end);
        if (row.voidBusinessDate !== expected) {
          changes.push({
            _id: row._id,
            transactionNumber: row.transactionNumber,
            outlet: row.outlet,
            timestampSource: row.voidedAt
              ? 'voidedAt'
              : row.qrOrder?.declinedAt
                ? 'qrOrder.declinedAt'
                : row.updatedAt
                  ? 'updatedAt'
                  : 'createdAt',
            cancellationInstant: instant,
            before: row.voidBusinessDate ?? null,
            after: expected,
          });
        }
      }

      snapshots.push({
        tenant: tenant.slug,
        database: conn.name,
        outlets: outlets.map((outlet) => ({
          _id: outlet._id,
          name: outlet.name,
          code: outlet.code,
          timezone: outlet.timezone || 'Asia/Karachi',
          businessDayStart: outlet.businessDayStart || '00:00',
          businessDayEnd: outlet.businessDayEnd || outlet.businessDayStart || '00:00',
        })),
        totalCancelled: rows.length,
        changes,
        unresolved,
      });

      console.log(`[${tenant.slug}] cancelled=${rows.length}, changes=${changes.length}, unresolved=${unresolved.length}`);
      for (const outlet of outlets) {
        console.log(
          `  outlet=${outlet.name || outlet.code || outlet._id} `
          + `timezone=${outlet.timezone || 'Asia/Karachi'} `
          + `businessDay=${outlet.businessDayStart || '00:00'}-${outlet.businessDayEnd || outlet.businessDayStart || '00:00'}`,
        );
      }
    }

    if (!APPLY) {
      if (snapshots.some((snapshot) => snapshot.unresolved.length)) {
        process.exitCode = 2;
      }
      return;
    }

    const unresolvedCount = snapshots.reduce((sum, snapshot) => sum + snapshot.unresolved.length, 0);
    if (unresolvedCount) {
      throw new Error(`Refusing to apply: ${unresolvedCount} cancelled orders could not be resolved.`);
    }

    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.writeFile(
      backupFile,
      `${JSON.stringify({
        migration: 'cancelled-order-business-date-backfill',
        createdAt: new Date().toISOString(),
        snapshots,
      }, null, 2)}\n`,
      { flag: 'wx' },
    );
    console.log(`Backup written: ${backupFile}`);

    for (const snapshot of snapshots) {
      const conn = connections.find((candidate) => candidate.name === snapshot.database);
      if (snapshot.changes.length) {
        await conn.collection('saletransactions').bulkWrite(
          snapshot.changes.map((change) => ({
            updateOne: {
              filter: { _id: change._id, status: 'void' },
              update: { $set: { voidBusinessDate: change.after } },
            },
          })),
          { ordered: true },
        );
      }
      const remaining = await conn.collection('saletransactions').countDocuments({
        status: 'void',
        voidBusinessDate: { $not: /^\d{4}-\d{2}-\d{2}$/ },
      });
      if (remaining) throw new Error(`[${snapshot.tenant}] verification failed: ${remaining} rows remain unconverted.`);
      console.log(`[${snapshot.tenant}] verified ${snapshot.totalCancelled} cancelled orders.`);
    }
  } finally {
    await closeAll(connections);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
