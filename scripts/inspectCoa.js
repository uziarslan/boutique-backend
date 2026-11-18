/**
 * READ-ONLY: dump the chart of accounts for a tenant (default the-smash-ove) and
 * list all tenant slugs. Makes no writes.
 *
 * Usage: MONGO_URI=... node scripts/inspectCoa.js [slug]
 */
import 'dotenv/config';
import { connectPlatform, getTenantConnectionFor, getPlatformConnection } from '../src/db/connections.js';
import { TenantModel } from '../src/platform/models/Tenant.js';

const run = async () => {
  await connectPlatform();
  const tenants = await TenantModel().find({}, 'slug name').lean();
  console.log('TENANTS:', tenants.map((t) => t.slug).join(', '));

  const slug = process.argv[2] || 'the-smash-ove';
  const conn = await getTenantConnectionFor(slug);
  const accts = await conn.collection('chartofaccounts').find({}).sort({ code: 1 }).toArray();

  console.log(`\n=== ${slug}: chart of accounts (${accts.length}) ===`);
  console.log('CODE\tTYPE\tNORMAL\tSUBTYPE\tSYS\tACTIVE\tNAME');
  for (const a of accts) {
    console.log(`${a.code}\t${a.type}\t${a.normalBalance}\t${a.subType || '-'}\t${a.isSystemAccount ? 'Y' : 'n'}\t${a.isActive ? 'Y' : 'n'}\t${a.name}`);
  }

  await conn.close();
  try { await getPlatformConnection().close(); } catch { /* noop */ }
  process.exit(0);
};

run().catch((e) => { console.error(e); process.exit(1); });
