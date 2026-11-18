#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildUri,
  connectPlatform,
  getPlatformConnection,
} from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';

const destination = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
if (!destination) {
  console.error('Usage: node src/scripts/backupBeforePurchaseMigration.js --out=/absolute/backup/path');
  process.exit(1);
}
if (!path.isAbsolute(destination)) {
  console.error('Backup destination must be an absolute path.');
  process.exit(1);
}

const mongodump = process.env.MONGODUMP_BIN || '/opt/homebrew/bin/mongodump';

const dumpDatabase = (dbName) => new Promise((resolve, reject) => {
  const child = spawn(mongodump, [
    `--uri=${buildUri(dbName)}`,
    `--db=${dbName}`,
    `--out=${destination}`,
    '--gzip',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[backup] ${dbName}: complete`);
      resolve();
    } else {
      reject(new Error(`[backup] ${dbName}: mongodump exited ${code}: ${stderr.slice(-500)}`));
    }
  });
});

const main = async () => {
  await fs.mkdir(destination, { recursive: true });
  await connectPlatform();
  const platformDb = process.env.PLATFORM_DB_NAME || 'platform';
  const tenants = await TenantModel().find({}).select('slug').sort({ slug: 1 }).lean();
  const databases = [platformDb, ...tenants.map((tenant) => tenant.slug)];
  for (const dbName of databases) await dumpDatabase(dbName);
  await fs.writeFile(path.join(destination, 'purchase-migration-backup.json'), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: 'Pre unified-purchase production migration',
    databases,
    compressed: true,
  }, null, 2)}\n`);
  await getPlatformConnection().close();
  console.log(`[backup] verified dump completed at ${destination}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
