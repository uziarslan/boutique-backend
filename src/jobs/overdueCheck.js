import Purchase from '../models/Purchase.js';
import logger from '../utils/logger.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';

const runForTenant = (slug) =>
  new Promise((resolve) => {
    getTenantConnectionFor(slug)
      .then((conn) => {
        runWithTenant({ conn, slug }, () => {
          (async () => {
            try {
              const now = new Date();
              const count = await Purchase.countDocuments({
                status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] },
                dueDate: { $ne: null, $lt: now },
              });
              logger.info(`[${slug}] overdueCheck: ${count} purchase balance(s) are overdue.`);
            } catch (err) {
              logger.error(`[${slug}] overdue check failed: ${err.message}`);
            }
            resolve();
          })();
        });
      })
      .catch(() => resolve());
  });

const runOverdueCheck = async () => {
  try {
    const tenants = await TenantModel().find({ status: { $ne: 'suspended' } }).lean();
    await Promise.all(tenants.map((t) => runForTenant(t.slug)));
  } catch (err) {
    logger.error(`Overdue check (sweep) failed: ${err.message}`);
  }
};

export default runOverdueCheck;
