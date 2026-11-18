/**
 * Migration: standardize the sales-side chart of accounts so POS sales can be
 * broken out into Sales Revenue / Delivery Charges / Service Charge / Discounts /
 * Sales Tax Payable (see postSale in journalEngine.js).
 *
 * Per tenant DB:
 *   - Rename 4001 "Food Sales Revenue" → "Sales Revenue".
 *   - Upsert 2300 Sales Tax Payable (liability), 4004 Delivery Charges,
 *     4005 Service Charge, 4007 Discounts (revenue). Existing manual accounts at
 *     these codes are renamed/normalized and marked as system (default) heads.
 *   - Deactivate 4002 Beverage Sales Revenue (kept for historical entries, hidden
 *     from new postings).
 *
 * Idempotent. DRY-RUN by default — pass --apply to write.
 *
 * Usage:
 *   MONGO_URI=... node scripts/migrateSalesAccounts.js            # dry run
 *   MONGO_URI=... node scripts/migrateSalesAccounts.js --apply    # write
 */
import 'dotenv/config';
import { connectPlatform, getTenantConnectionFor, getPlatformConnection } from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';

const APPLY = process.argv.includes('--apply');

const UPSERTS = [
  { code: '4001', name: 'Sales Revenue',     type: 'revenue',   subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '2300', name: 'Sales Tax Payable', type: 'liability', subType: 'currentLiability', normalBalance: 'credit' },
  { code: '4004', name: 'Delivery Charges',  type: 'revenue',   subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4005', name: 'Service Charge',    type: 'revenue',   subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4007', name: 'Discounts',         type: 'revenue',   subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '1110', name: 'Food Panda Receivable',       type: 'asset',    subType: 'currentAsset',   normalBalance: 'debit' },
  { code: '5007', name: 'Food Panda Commission Expense', type: 'expense',  subType: 'operatingExpense', normalBalance: 'debit' },
];
const DEACTIVATE = ['4002'];
const FIELDS = ['name', 'type', 'subType', 'normalBalance', 'isSystemAccount', 'isActive'];

const RESTORE = [
  // 5006 was a user-created "Carriage Inwards" head in the-smash-ove before the
  // previous migration accidentally renamed it. Restore it as a non-system account.
  { code: '5006', name: 'Carriage Inwards', type: 'expense', subType: '', normalBalance: 'debit', isSystemAccount: false, isActive: true },
];

const migrateTenant = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  const col = conn.collection('chartofaccounts');
  const changes = [];

  for (const t of RESTORE) {
    const cur = await col.findOne({ code: t.code });
    if (cur && cur.isSystemAccount) {
      changes.push(`  RESTORE ${t.code} "${cur.name}" → "${t.name}" (non-system)`);
      if (APPLY) {
        await col.updateOne(
          { code: t.code },
          { $set: { name: t.name, subType: t.subType, isSystemAccount: t.isSystemAccount, isActive: t.isActive } },
        );
      }
    }
  }

  for (const t of UPSERTS) {
    const desired = { ...t, isSystemAccount: true, isActive: true };
    const cur = await col.findOne({ code: t.code });
    if (!cur) {
      changes.push(`  CREATE ${t.code} "${t.name}" (${t.type}/${t.normalBalance})`);
      if (APPLY) await col.updateOne({ code: t.code }, { $set: desired }, { upsert: true });
      continue;
    }
    const diffs = FIELDS
      .filter((f) => (cur[f] ?? (f === 'subType' ? '' : cur[f])) !== desired[f])
      .filter((f) => !(f === 'subType' && !cur[f] && !desired[f]))
      .map((f) => `${f}: ${JSON.stringify(cur[f])} → ${JSON.stringify(desired[f])}`);
    if (diffs.length) {
      changes.push(`  UPDATE ${t.code} "${cur.name}" — ${diffs.join(', ')}`);
      if (APPLY) await col.updateOne({ code: t.code }, { $set: desired });
    } else {
      changes.push(`  OK     ${t.code} "${cur.name}" (no change)`);
    }
  }

  for (const code of DEACTIVATE) {
    const cur = await col.findOne({ code });
    if (cur && cur.isActive) {
      changes.push(`  DEACTIVATE ${code} "${cur.name}"`);
      if (APPLY) await col.updateOne({ code }, { $set: { isActive: false } });
    } else if (cur) {
      changes.push(`  OK     ${code} "${cur.name}" (already inactive)`);
    }
  }

  console.log(`\n[${slug}]`);
  changes.forEach((c) => console.log(c));
  return conn;
};

const run = async () => {
  console.log(APPLY ? '*** APPLY MODE — writing changes ***' : '--- DRY RUN (no writes). Pass --apply to write. ---');
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug').lean();
  console.log(`Sales-accounts migration: ${tenants.length} tenant(s).`);

  const conns = [];
  let ok = 0, failed = 0;
  for (const t of tenants) {
    try { conns.push(await migrateTenant(t.slug)); ok += 1; }
    catch (err) { failed += 1; console.error(`[${t.slug}] FAILED: ${err.message}`); }
  }

  console.log(`\nDone. ${ok} tenant(s) processed, ${failed} failed.${APPLY ? '' : ' (dry run — nothing written)'}`);
  await Promise.allSettled(conns.map((c) => c.close()));
  try { await getPlatformConnection().close(); } catch { /* noop */ }
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => { console.error(`Migration crashed: ${err.message}`); process.exit(1); });
