import logger from '../utils/logger.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import { runExpirySweep } from '../services/loyalty.service.js';
import { resolveAggregateOutletFeatures } from '../services/outletFeatures.service.js';

// Loyalty customers are shared by the tenant today, so one sweep is sufficient
// whenever at least one outlet has Membership / Rewards enabled.
const isEnabled = (tenant) => (
  resolveAggregateOutletFeatures(tenant).membershipRewards === true
);

const runForTenant = (slug) =>
  new Promise((resolve) => {
    getTenantConnectionFor(slug)
      .then((conn) => {
        runWithTenant({ conn, slug }, () => {
          (async () => {
            try {
              const result = await runExpirySweep({ userId: null });
              logger.info(`[${slug}] loyaltyExpiry: ${result.expired} pts across ${result.customersAffected} customer(s)`);
            } catch (err) {
              logger.error(`[${slug}] loyaltyExpiry failed: ${err.message}`);
            }
            resolve();
          })();
        });
      })
      .catch(() => resolve());
  });

const runLoyaltyExpiry = async () => {
  try {
    const tenants = await TenantModel().find({ status: { $ne: 'suspended' } }).lean();
    const eligible = tenants.filter(isEnabled);
    await Promise.all(eligible.map((t) => runForTenant(t.slug)));
  } catch (err) {
    logger.error(`Loyalty expiry (sweep) failed: ${err.message}`);
  }
};

export default runLoyaltyExpiry;
