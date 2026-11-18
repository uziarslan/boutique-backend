/**
 * Persist system parties and tag historical receivable journals in every tenant.
 *
 * Dry-run:
 *   node scripts/backfillSystemParties.js
 *
 * Apply (requires a recovery snapshot):
 *   node scripts/backfillSystemParties.js --apply --backup=../backups/system-parties.json
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

const APPLY = process.argv.includes('--apply');
const backupArg = process.argv.find((arg) => arg.startsWith('--backup='));
const backupFile = backupArg ? path.resolve(backupArg.slice('--backup='.length)) : null;
const PARTIES = [
  { name: 'Food Panda Sales', nameLower: 'food panda sales' },
  { name: 'Salary Advance', nameLower: 'salary advance' },
];

const filtersFor = async (conn) => {
  const accounts = await conn.collection('chartofaccounts')
    .find({ code: { $in: ['1110', '1102'] } }, { projection: { _id: 1, code: 1 } })
    .toArray();
  const byCode = Object.fromEntries(accounts.map((account) => [account.code, account._id]));
  return {
    foodPanda: byCode['1110']
      ? { sourceModule: 'pos', 'lines.account': byCode['1110'] }
      : { _id: null },
    salaryAdvance: { sourceModule: 'salaryAdvance' },
    salaryRecovery: byCode['1102']
      ? {
          sourceModule: 'salary',
          lines: { $elemMatch: { account: byCode['1102'], credit: { $gt: 0 } } },
        }
      : { _id: null },
  };
};

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
      const filters = await filtersFor(conn);
      const [existingParties, foodRows, advanceRows, recoveryRows] = await Promise.all([
        conn.collection('customparties').find(
          { nameLower: { $in: PARTIES.map((party) => party.nameLower) } },
        ).toArray(),
        conn.collection('journalentries').find(filters.foodPanda, { projection: { _id: 1, party: 1 } }).toArray(),
        conn.collection('journalentries').find(filters.salaryAdvance, { projection: { _id: 1, party: 1 } }).toArray(),
        conn.collection('journalentries').find(filters.salaryRecovery, { projection: { _id: 1, party: 1 } }).toArray(),
      ]);
      const journalBefore = new Map();
      for (const row of [...foodRows, ...advanceRows, ...recoveryRows]) {
        journalBefore.set(row._id.toString(), row);
      }
      snapshots.push({
        tenant: tenant.slug,
        database: conn.name,
        existingParties,
        journalBefore: [...journalBefore.values()],
        counts: {
          foodPanda: foodRows.length,
          salaryAdvance: advanceRows.length,
          salaryRecovery: recoveryRows.length,
        },
      });
      console.log(
        `[${tenant.slug}] parties=${existingParties.length}/2, ` +
        `Food Panda journals=${foodRows.length}, Salary Advance journals=${advanceRows.length}, ` +
        `salary recoveries=${recoveryRows.length}`,
      );
    }

    if (!APPLY) return;

    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.writeFile(
      backupFile,
      `${JSON.stringify({
        migration: 'system-parties-backfill',
        createdAt: new Date().toISOString(),
        snapshots,
      }, null, 2)}\n`,
      { flag: 'wx' },
    );
    console.log(`Backup written: ${backupFile}`);

    for (const snapshot of snapshots) {
      const conn = connections.find((candidate) => candidate.name === snapshot.database);
      const filters = await filtersFor(conn);
      await conn.collection('customparties').bulkWrite(PARTIES.map((party) => ({
        updateOne: {
          filter: { nameLower: party.nameLower },
          update: {
            $set: { ...party, isSystem: true, updatedAt: new Date() },
            $setOnInsert: { createdBy: null, createdAt: new Date() },
          },
          upsert: true,
        },
      })));
      await Promise.all([
        conn.collection('journalentries').updateMany(
          filters.foodPanda,
          { $set: { party: 'Food Panda Sales', updatedAt: new Date() } },
        ),
        conn.collection('journalentries').updateMany(
          filters.salaryAdvance,
          { $set: { party: 'Salary Advance', updatedAt: new Date() } },
        ),
        conn.collection('journalentries').updateMany(
          filters.salaryRecovery,
          { $set: { party: 'Salary Advance', updatedAt: new Date() } },
        ),
      ]);

      const [partyCount, foodMissing, advanceMissing, recoveryMissing] = await Promise.all([
        conn.collection('customparties').countDocuments({
          nameLower: { $in: PARTIES.map((party) => party.nameLower) },
          isSystem: true,
        }),
        conn.collection('journalentries').countDocuments({ ...filters.foodPanda, party: { $ne: 'Food Panda Sales' } }),
        conn.collection('journalentries').countDocuments({ ...filters.salaryAdvance, party: { $ne: 'Salary Advance' } }),
        conn.collection('journalentries').countDocuments({ ...filters.salaryRecovery, party: { $ne: 'Salary Advance' } }),
      ]);
      if (partyCount !== 2 || foodMissing || advanceMissing || recoveryMissing) {
        throw new Error(`[${snapshot.tenant}] verification failed`);
      }
      console.log(`[${snapshot.tenant}] VERIFIED`);
    }
  } finally {
    await closeAll(connections);
  }
};

run().catch((err) => {
  console.error(`Backfill failed: ${err.message}`);
  process.exitCode = 1;
});
