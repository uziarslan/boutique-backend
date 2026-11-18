/**
 * One-off: permanently delete the retired 4002 "Beverage Sales Revenue" head.
 *
 * Per tenant DB: refuses to delete if ANY journal entry line references it, or if
 * it has sub-accounts (that would orphan the ledger). Otherwise removes it. It is
 * already gone from seedAccounts.js, so new tenants never get it.
 *
 * DRY-RUN by default — pass --apply to write.
 *
 * Usage:
 *   MONGO_URI=... node scripts/deleteBeverageAccount.js            # dry run
 *   MONGO_URI=... node scripts/deleteBeverageAccount.js --apply    # delete
 */
import 'dotenv/config';
import { connectPlatform, getTenantConnectionFor, getPlatformConnection } from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';

const APPLY = process.argv.includes('--apply');
const CODE = '4002';

const run = async () => {
  console.log(APPLY ? '*** APPLY MODE — deleting ***' : '--- DRY RUN (no writes). Pass --apply to delete. ---');
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug').lean();

  const conns = [];
  for (const t of tenants) {
    const conn = await getTenantConnectionFor(t.slug);
    conns.push(conn);
    const coa = conn.collection('chartofaccounts');
    const je = conn.collection('journalentries');

    const acct = await coa.findOne({ code: CODE });
    if (!acct) { console.log(`[${t.slug}] ${CODE} absent — nothing to do.`); continue; }

    const refCount = await je.countDocuments({ 'lines.account': acct._id });
    const childCount = await coa.countDocuments({ parentAccount: acct._id });

    if (refCount > 0 || childCount > 0) {
      console.log(`[${t.slug}] ${CODE} "${acct.name}" — KEEP (referenced by ${refCount} journal entr(y/ies), ${childCount} sub-account(s)). Not deleting.`);
      continue;
    }

    if (APPLY) {
      await coa.deleteOne({ _id: acct._id });
      console.log(`[${t.slug}] ${CODE} "${acct.name}" — DELETED (0 references).`);
    } else {
      console.log(`[${t.slug}] ${CODE} "${acct.name}" — safe to delete (0 references).`);
    }
  }

  await Promise.allSettled(conns.map((c) => c.close()));
  try { await getPlatformConnection().close(); } catch { /* noop */ }
  process.exit(0);
};

run().catch((err) => { console.error(`Crashed: ${err.message}`); process.exit(1); });
