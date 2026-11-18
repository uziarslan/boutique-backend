import { TenantModel } from '../platform/models/Tenant.js';
import { BillingInvoiceModel } from '../platform/models/BillingInvoice.js';
import { ensureRenewalInvoice, DAY_MS } from '../platform/services/billing.service.js';
import { sendBillingEmail } from '../platform/services/billingEmail.service.js';
import logger from '../utils/logger.js';

const LEASE_MS = 15 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const MAX_PER_RUN = 100;

const claimNextReminder = (now) => BillingInvoiceModel().findOneAndUpdate(
  {
    status: { $in: ['issued', 'overdue'] },
    balance: { $gt: 0 },
    remindersEnabled: true,
    nextReminderAt: { $ne: null, $lte: now },
    $or: [
      { reminderLeaseUntil: null },
      { reminderLeaseUntil: { $exists: false } },
      { reminderLeaseUntil: { $lte: now } },
    ],
  },
  {
    $set: {
      reminderLeaseUntil: new Date(now.getTime() + LEASE_MS),
      lastReminderError: '',
    },
  },
  { sort: { nextReminderAt: 1 }, returnDocument: 'after' },
);

export const runBillingReminders = async ({ now = new Date() } = {}) => {
  const warningCutoff = new Date(now.getTime() + 7 * DAY_MS);
  const tenants = await TenantModel().find({
    status: { $ne: 'suspended' },
    accessUntil: { $ne: null, $lte: warningCutoff },
    'billing.recurringAmount': { $gt: 0 },
    'billing.remindersEnabled': true,
  });

  let created = 0;
  for (const tenant of tenants) {
    try {
      const result = await ensureRenewalInvoice({ tenant, actor: 'billing-scheduler', now });
      if (result.created) created += 1;
    } catch (error) {
      logger.error(`[billing] invoice creation failed for ${tenant.slug}: ${error.message}`);
    }
  }

  await BillingInvoiceModel().updateMany(
    { status: 'issued', balance: { $gt: 0 }, dueDate: { $lte: now } },
    { $set: { status: 'overdue' } },
  );

  let sent = 0;
  let failed = 0;
  for (let index = 0; index < MAX_PER_RUN; index += 1) {
    const invoice = await claimNextReminder(now);
    if (!invoice) break;
    const type = invoice.invoiceSentAt ? 'reminder' : 'invoice';
    try {
      await sendBillingEmail({
        invoice,
        type,
        deliveryKey: `${invoice._id}:${type}:${invoice.reminderCount + 1}`,
        triggeredBy: 'billing-scheduler',
        now,
      });
      const update = {
        $set: {
          reminderLeaseUntil: null,
          lastReminderAt: now,
          nextReminderAt: new Date(now.getTime() + DAY_MS),
          lastReminderError: '',
        },
        $inc: { reminderCount: 1 },
        $push: {
          auditTrail: {
            action: type === 'invoice' ? 'invoiceEmailed' : 'reminderEmailed',
            at: new Date(),
            by: 'billing-scheduler',
          },
        },
      };
      if (type === 'invoice') update.$set.invoiceSentAt = new Date();
      await BillingInvoiceModel().updateOne({ _id: invoice._id }, update);
      sent += 1;
    } catch (error) {
      failed += 1;
      await BillingInvoiceModel().updateOne(
        { _id: invoice._id },
        {
          $set: {
            reminderLeaseUntil: null,
            nextReminderAt: new Date(now.getTime() + FAILURE_RETRY_MS),
            lastReminderError: String(error?.message || error).slice(0, 1000),
          },
        },
      );
      logger.error(`[billing] ${type} email failed for ${invoice.invoiceNumber}: ${error.message}`);
    }
  }

  const summary = { tenants: tenants.length, created, sent, failed };
  logger.info(`[billing] reminder sweep: ${JSON.stringify(summary)}`);
  return summary;
};

export default runBillingReminders;
