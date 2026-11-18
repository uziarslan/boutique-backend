import logger from '../utils/logger.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { submitCreditToPra, submitSaleToPra } from '../services/pra.service.js';

const MAX_PER_TENANT = 300;
const TENANT_CONCURRENCY = 5;

const runForTenant = (slug) => new Promise((resolve) => {
  getTenantConnectionFor(slug)
    .then((conn) => runWithTenant({ conn, slug }, async () => {
      try {
        const staleCut = new Date(Date.now() - 5 * 60 * 1000);
        await Promise.all([
          SaleTransaction.updateMany(
            { status: 'completed', 'pra.status': 'submitting', 'pra.submittedAt': { $lt: staleCut } },
            { $set: { 'pra.status': 'pending' } },
          ),
          SaleTransaction.updateMany(
            { status: { $in: ['void', 'refunded'] }, 'pra.credit.status': 'submitting', 'pra.credit.submittedAt': { $lt: staleCut } },
            { $set: { 'pra.credit.status': 'pending' } },
          ),
        ]);

        const [sales, credits] = await Promise.all([
          SaleTransaction.find({ status: 'completed', 'pra.status': 'pending' })
            .sort({ createdAt: 1 }).limit(MAX_PER_TENANT),
          SaleTransaction.find({ status: { $in: ['void', 'refunded'] }, 'pra.credit.status': 'pending' })
            .sort({ voidedAt: 1, createdAt: 1 }).limit(MAX_PER_TENANT),
        ]);

        let saleReported = 0;
        for (const transaction of sales) {
          const result = await submitSaleToPra(transaction);
          if (result?.status === 'reported') saleReported += 1;
        }
        let creditReported = 0;
        for (const transaction of credits) {
          const result = await submitCreditToPra(transaction);
          if (result?.status === 'reported') creditReported += 1;
        }
        if (sales.length || credits.length) {
          logger.info(
            `[${slug}] praRetry: sales ${saleReported}/${sales.length}, credits ${creditReported}/${credits.length} reported`,
          );
        }
      } catch (error) {
        logger.error(`[${slug}] praRetry failed: ${error.message}`);
      }
    }))
    .catch(() => {})
    .finally(resolve);
});

let sweeping = false;

const runPraRetry = async () => {
  if (sweeping) {
    logger.warn('[praRetry] previous sweep still running; skipping this tick.');
    return;
  }
  sweeping = true;
  try {
    const tenants = await TenantModel().find({ status: { $ne: 'suspended' } }).lean();
    for (let index = 0; index < tenants.length; index += TENANT_CONCURRENCY) {
      await Promise.all(tenants.slice(index, index + TENANT_CONCURRENCY).map((tenant) => runForTenant(tenant.slug)));
    }
  } catch (error) {
    logger.error(`PRA retry sweep failed: ${error.message}`);
  } finally {
    sweeping = false;
  }
};

export default runPraRetry;
