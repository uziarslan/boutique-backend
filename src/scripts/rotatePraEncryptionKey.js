#!/usr/bin/env node
import 'dotenv/config';
import {
  closeAllConnections,
  connectPlatform,
  getTenantConnectionFor,
} from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptedWithCurrentKey,
} from '../utils/secretBox.js';

const apply = process.argv.includes('--apply');
const tokenPaths = ['pra.sandboxToken', 'pra.productionToken'];

const main = async () => {
  if (!process.env.PRA_ENC_KEY || !process.env.PRA_ENC_KEY_PREVIOUS) {
    throw new Error('PRA_ENC_KEY and PRA_ENC_KEY_PREVIOUS are both required for rotation.');
  }
  if (process.env.PRA_ENC_KEY === process.env.PRA_ENC_KEY_PREVIOUS) {
    throw new Error('PRA_ENC_KEY must differ from PRA_ENC_KEY_PREVIOUS.');
  }

  await connectPlatform();
  const tenants = await TenantModel().find({}).select('slug').sort({ slug: 1 }).lean();
  let tokenCount = 0;
  let rotationCount = 0;
  let currentCount = 0;
  let failureCount = 0;
  console.log(`[pra-key-rotation] mode=${apply ? 'APPLY' : 'DRY-RUN'} tenants=${tenants.length}`);

  for (const tenant of tenants) {
    const conn = await getTenantConnectionFor(tenant.slug);
    const outlets = await conn.collection('outlets').find(
      { $or: tokenPaths.map((path) => ({ [path]: { $type: 'string', $ne: '' } })) },
      { projection: { 'pra.sandboxToken': 1, 'pra.productionToken': 1 } },
    ).toArray();
    const operations = [];
    let tenantRotations = 0;

    for (const outlet of outlets) {
      const updates = {};
      for (const path of tokenPaths) {
        const field = path.split('.')[1];
        const blob = outlet.pra?.[field];
        if (!blob) continue;
        tokenCount += 1;
        if (isSecretEncryptedWithCurrentKey(blob)) {
          currentCount += 1;
          continue;
        }
        const plain = decryptSecret(blob);
        if (!plain) {
          failureCount += 1;
          console.error(`[pra-key-rotation] ${tenant.slug}: could not decrypt ${field} for outlet=${outlet._id}`);
          continue;
        }
        updates[path] = encryptSecret(plain);
        rotationCount += 1;
        tenantRotations += 1;
      }
      if (Object.keys(updates).length) {
        operations.push({ updateOne: { filter: { _id: outlet._id }, update: { $set: updates } } });
      }
    }
    if (apply && operations.length) await conn.collection('outlets').bulkWrite(operations, { ordered: true });
    console.log(`[pra-key-rotation] ${tenant.slug}: outlets=${outlets.length} tokensToRotate=${tenantRotations}`);
  }

  console.log(
    `[pra-key-rotation] complete mode=${apply ? 'APPLY' : 'DRY-RUN'} tokens=${tokenCount} `
    + `rotate=${rotationCount} alreadyCurrent=${currentCount} failures=${failureCount}`,
  );
  if (failureCount) throw new Error(`Refusing to complete: ${failureCount} PRA token(s) could not be decrypted.`);
};

main()
  .catch((error) => {
    console.error(`[pra-key-rotation] failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(closeAllConnections);
