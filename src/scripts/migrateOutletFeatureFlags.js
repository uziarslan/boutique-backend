#!/usr/bin/env node
import 'dotenv/config';
import {
  connectPlatform,
  getPlatformConnection,
  getTenantConnectionFor,
} from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  ensureOutletFeatureAssignments,
  syncLegacyFeatureProjections,
} from '../services/outletFeatures.service.js';

const apply = process.argv.includes('--apply');
const tenantArg = process.argv.find((arg) => arg.startsWith('--tenant='));
const onlyTenant = tenantArg ? tenantArg.slice('--tenant='.length).trim().toLowerCase() : null;
const openedTenantConnections = new Set();

const main = async () => {
  await connectPlatform();

  const filter = onlyTenant ? { slug: onlyTenant } : {};
  const tenants = await TenantModel().find(filter).sort({ slug: 1 });
  let outletCount = 0;
  let assignmentCount = 0;

  console.log(
    `[outlet-features] mode=${apply ? 'APPLY' : 'DRY-RUN'} tenants=${tenants.length}`
  );

  for (const tenant of tenants) {
    const conn = await getTenantConnectionFor(tenant.slug);
    openedTenantConnections.add(conn);
    const outlets = await conn.collection('outlets')
      .find({}, { projection: { _id: 1, code: 1, name: 1 } })
      .toArray();
    const before = tenant.outletFeatures?.length || 0;

    await ensureOutletFeatureAssignments(tenant, outlets, {
      completeMigration: true,
      updatedBy: 'script:migrate-outlet-features',
      save: false,
    });
    syncLegacyFeatureProjections(tenant);

    const after = tenant.outletFeatures?.length || 0;
    outletCount += outlets.length;
    assignmentCount += Math.max(0, after - before);

    if (apply) await tenant.save();
    console.log(
      `[outlet-features] ${tenant.slug}: outlets=${outlets.length} ` +
      `existing=${before} created=${Math.max(0, after - before)}`
    );
  }

  console.log(
    `[outlet-features] complete mode=${apply ? 'APPLY' : 'DRY-RUN'} ` +
    `outlets=${outletCount} newAssignments=${assignmentCount}`
  );
};

main()
  .catch((err) => {
    console.error(`[outlet-features] failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled(
      [...openedTenantConnections].map((connection) => connection.close())
    );
    try {
      await getPlatformConnection().close();
    } catch {
      // Platform may not have connected.
    }
  });
