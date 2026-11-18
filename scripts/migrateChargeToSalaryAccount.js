/**
 * Promote tenant COA code 4006 to the default system "Charge to Salary" head.
 *
 * Historical journal lines reference the account ObjectId, so this migration
 * updates the existing document in place. It is idempotent and dry-run by
 * default. Apply mode requires a backup path and records the before-state of
 * every tenant before making any write.
 *
 * Usage:
 *   node scripts/migrateChargeToSalaryAccount.js
 *   node scripts/migrateChargeToSalaryAccount.js --apply --backup=/safe/path/charge-to-salary-coa.json
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectPlatform, getTenantConnectionFor, getPlatformConnection } from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';

const APPLY = process.argv.includes('--apply');
const backupArg = process.argv.find((arg) => arg.startsWith('--backup='));
const backupFile = backupArg ? path.resolve(backupArg.slice('--backup='.length)) : null;
const CODE = '4006';
const DESIRED = {
  code: CODE,
  name: 'Charge to Salary',
  type: 'revenue',
  subType: 'operatingRevenue',
  normalBalance: 'credit',
  isSystemAccount: true,
  isActive: true,
};
const FIELDS = ['name', 'type', 'subType', 'normalBalance', 'isSystemAccount', 'isActive'];

const closeAll = async (conns) => {
  await Promise.allSettled(conns.map((conn) => conn.close()));
  try { await getPlatformConnection().close(); } catch { /* noop */ }
};

const run = async () => {
  if (APPLY && !backupFile) {
    throw new Error('Apply mode requires --backup=/absolute/or/relative/path.json');
  }

  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (no writes) ---');
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug name').sort({ slug: 1 }).lean();
  const conns = [];
  const snapshots = [];
  let failed = 0;

  try {
    // Complete the read/backup pass before the first write.
    for (const tenant of tenants) {
      try {
        const conn = await getTenantConnectionFor(tenant.slug);
        conns.push(conn);
        const before = await conn.collection('chartofaccounts').findOne({ code: CODE });
        snapshots.push({
          tenant: tenant.slug,
          database: conn.name,
          before,
        });
      } catch (err) {
        failed += 1;
        console.error(`[${tenant.slug}] READ FAILED: ${err.message}`);
      }
    }

    if (APPLY) {
      if (failed > 0) {
        throw new Error('Backup pass failed for one or more tenants; no writes were made.');
      }
      await fs.mkdir(path.dirname(backupFile), { recursive: true });
      await fs.writeFile(
        backupFile,
        `${JSON.stringify({
          migration: 'charge-to-salary-account-4006',
          createdAt: new Date().toISOString(),
          snapshots,
        }, null, 2)}\n`,
        { flag: 'wx' },
      );
      console.log(`Backup written: ${backupFile}`);
    }

    for (const snapshot of snapshots) {
      const before = snapshot.before;
      const diffs = before
        ? FIELDS
          .filter((field) => (before[field] ?? '') !== (DESIRED[field] ?? ''))
          .map((field) => `${field}: ${JSON.stringify(before[field])} -> ${JSON.stringify(DESIRED[field])}`)
        : ['account does not exist'];
      console.log(
        `[${snapshot.tenant}] ${diffs.length ? `${before ? 'UPDATE' : 'CREATE'} ${CODE}: ${diffs.join(', ')}` : `OK ${CODE} "${DESIRED.name}"`}`
      );

      if (APPLY && diffs.length) {
        const conn = conns.find((candidate) => candidate.name === snapshot.database);
        await conn.collection('chartofaccounts').updateOne(
          { code: CODE },
          { $set: DESIRED },
          { upsert: true },
        );
      }
    }

    if (APPLY) {
      for (const snapshot of snapshots) {
        const conn = conns.find((candidate) => candidate.name === snapshot.database);
        const after = await conn.collection('chartofaccounts').findOne({ code: CODE });
        const invalid = !after || FIELDS.some((field) => (after[field] ?? '') !== (DESIRED[field] ?? ''));
        if (invalid) throw new Error(`[${snapshot.tenant}] verification failed for ${CODE}`);
        console.log(`[${snapshot.tenant}] VERIFIED ${after.code} "${after.name}" (system=${after.isSystemAccount})`);
      }
    }
  } finally {
    await closeAll(conns);
  }

  if (failed > 0) process.exitCode = 1;
};

run().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
});
