import { env } from '../config/env.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  claimPraOutboxEvent,
  publishClaimedPraEvent,
  recoverExpiredPraOutboxLeases,
  recoverStalePublishedPraEvents,
} from '../queues/pra.queue.js';
import logger from '../utils/logger.js';

const MAX_PER_TENANT = 300;
const TENANT_CONCURRENCY = 5;

const dispatchTenant = async (tenantSlug) => {
  const conn = await getTenantConnectionFor(tenantSlug);
  return runWithTenant({ conn, slug: tenantSlug }, async () => {
    const recovered = await recoverStalePublishedPraEvents();
    await recoverExpiredPraOutboxLeases();
    let published = 0;
    for (let i = 0; i < MAX_PER_TENANT; i += 1) {
      const event = await claimPraOutboxEvent();
      if (!event) break;
      const ok = await publishClaimedPraEvent(tenantSlug, event);
      if (!ok) break;
      published += 1;
    }
    return { published, ...recovered };
  });
};

export const runPraOutboxDispatch = async () => {
  if (!env.PRA_QUEUE_ENABLED) {
    logger.info('PRA queue disabled; no outbox events dispatched.');
    return { published: 0, requeued: 0, completed: 0 };
  }

  const tenants = await TenantModel().find({ status: { $ne: 'suspended' } })
    .select('slug')
    .lean();
  const totals = { published: 0, requeued: 0, completed: 0 };

  for (let i = 0; i < tenants.length; i += TENANT_CONCURRENCY) {
    const batch = tenants.slice(i, i + TENANT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((tenant) => dispatchTenant(tenant.slug)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        totals.published += result.value.published;
        totals.requeued += result.value.requeued;
        totals.completed += result.value.completed;
      } else {
        logger.error(
          `Outbox tenant dispatch failed: ${result.reason?.message || result.reason}`,
        );
      }
    }
  }

  logger.info(
    `Outbox dispatch completed: ${totals.published} published, ` +
    `${totals.requeued} stale event(s) requeued, ${totals.completed} reconciled.`,
  );
  return totals;
};
