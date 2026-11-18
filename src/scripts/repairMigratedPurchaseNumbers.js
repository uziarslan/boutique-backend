#!/usr/bin/env node
import 'dotenv/config';
import { connectPlatform, getPlatformConnection, getTenantConnectionFor } from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';

const args = new Set(process.argv.slice(2));
const valueFor = (name) => {
  const prefix = `${name}=`;
  const argument = [...args].find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
};
const apply = args.has('--apply');
const onlyTenant = valueFor('--tenant');
const duplicatedReference = /\b(INV|GRN|PO|PAY)(?:[\s-]+)\1(?=[\s-])/gi;
const suspiciousReference = /\b(INV|GRN|PO|PAY)(?:[\s-]+)\1(?=[\s-])/i;
const normalize = (value) => String(value || '').replace(duplicatedReference, '$1');

const repairTenant = async (slug) => {
  const connection = await getTenantConnectionFor(slug);
  const purchases = await connection.collection('purchases').find({
    $or: [
      { purchaseNumber: suspiciousReference },
      { 'legacy.grnNumber': suspiciousReference },
    ],
  }, {
    projection: { purchaseNumber: 1, 'legacy.grnNumber': 1 },
  }).toArray();
  const changes = [];

  for (const purchase of purchases) {
    const set = {};
    if (suspiciousReference.test(purchase.purchaseNumber || '')) {
      const normalizedNumber = normalize(purchase.purchaseNumber);
      const collision = await connection.collection('purchases').findOne({
        _id: { $ne: purchase._id },
        purchaseNumber: normalizedNumber,
      }, {
        projection: { _id: 1, purchaseNumber: 1 },
      });
      if (collision) {
        throw new Error(`Cannot rename ${purchase.purchaseNumber} to ${normalizedNumber}; ${normalizedNumber} already exists.`);
      }
      set.purchaseNumber = normalizedNumber;
    }
    if (suspiciousReference.test(purchase.legacy?.grnNumber || '')) {
      set['legacy.grnNumber'] = normalize(purchase.legacy.grnNumber);
    }
    if (Object.keys(set).length) changes.push({ purchaseId: purchase._id, before: purchase, set });
  }

  if (apply) {
    for (const change of changes) {
      await connection.collection('purchases').updateOne(
        { _id: change.purchaseId },
        { $set: change.set },
      );
      if (change.set.purchaseNumber) {
        await connection.collection('journalentries').updateMany(
          {
            $or: [
              { sourceModule: 'purchase', sourceId: change.purchaseId },
              { sourcePath: `/purchases/${change.purchaseId}` },
            ],
          },
          { $set: { sourceNumber: change.set.purchaseNumber } },
        );
      }
    }
  }

  // Some legacy journal rows carried a duplicated GRN/INV token in their own
  // human-readable description even after the linked purchase number was fixed.
  const journals = await connection.collection('journalentries').find({
    $or: [
      { sourceNumber: suspiciousReference },
      { description: suspiciousReference },
      { legacyDescription: suspiciousReference },
    ],
  }, {
    projection: { sourceNumber: 1, description: 1, legacyDescription: 1 },
  }).toArray();
  const journalChanges = journals.map((entry) => {
    const set = {};
    for (const field of ['sourceNumber', 'description', 'legacyDescription']) {
      if (suspiciousReference.test(entry[field] || '')) set[field] = normalize(entry[field]);
    }
    return { journalId: entry._id, before: entry, set };
  }).filter((entry) => Object.keys(entry.set).length);

  if (apply && journalChanges.length) {
    await connection.collection('journalentries').bulkWrite(journalChanges.map((change) => ({
      updateOne: { filter: { _id: change.journalId }, update: { $set: change.set } },
    })), { ordered: false });
  }

  return {
    tenant: slug,
    mode: apply ? 'apply' : 'dry-run',
    count: changes.length + journalChanges.length,
    purchaseChanges: changes.map(({ purchaseId, before, set }) => ({
      purchaseId: purchaseId.toString(),
      before: {
        purchaseNumber: before.purchaseNumber,
        legacyGrnNumber: before.legacy?.grnNumber,
      },
      after: set,
    })),
    journalChanges: journalChanges.map(({ journalId, before, set }) => ({
      journalId: journalId.toString(),
      before: {
        sourceNumber: before.sourceNumber,
        description: before.description,
        legacyDescription: before.legacyDescription,
      },
      after: set,
    })),
  };
};

const main = async () => {
  await connectPlatform();
  const tenants = await TenantModel().find(onlyTenant ? { slug: onlyTenant } : {})
    .select('slug')
    .sort({ slug: 1 })
    .lean();
  if (!tenants.length) throw new Error(onlyTenant ? `Tenant "${onlyTenant}" was not found.` : 'No tenants found.');

  const results = [];
  for (const tenant of tenants) results.push(await repairTenant(tenant.slug));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', results }, null, 2));

  await Promise.all(tenants.map(async ({ slug }) => {
    try { await (await getTenantConnectionFor(slug)).close(); } catch { /* best effort */ }
  }));
  await getPlatformConnection().close();
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
