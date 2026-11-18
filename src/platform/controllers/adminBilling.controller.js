import mongoose from 'mongoose';
import { TenantModel } from '../models/Tenant.js';
import { BillingInvoiceModel } from '../models/BillingInvoice.js';
import { BillingEmailLogModel } from '../models/BillingEmailLog.js';
import {
  ensureRenewalInvoice,
  recordInvoicePayment,
  sanitizeBillingInvoice,
} from '../services/billing.service.js';
import { generateInvoicePdf, generateReceiptPdf } from '../services/billingPdf.service.js';
import { sendBillingEmail, sendPaymentConfirmation } from '../services/billingEmail.service.js';
import { cacheDel, tenantKey } from '../../utils/requestCache.js';
import logger from '../../utils/logger.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CYCLES = new Set(['monthly', 'quarterly', 'annual', 'custom']);

const requireObjectId = (value, label = 'ID') => {
  if (mongoose.isValidObjectId(value)) return;
  const error = new Error(`Invalid ${label}.`);
  error.statusCode = 400;
  throw error;
};

const emailLogJson = (row) => ({
  id: row._id,
  invoice: row.invoice,
  type: row.type,
  recipient: row.recipient,
  status: row.status,
  attemptedAt: row.attemptedAt,
  sentAt: row.sentAt,
  providerMessageIds: row.providerMessageIds || [],
  error: row.error,
  triggeredBy: row.triggeredBy,
});

const parseBillingConfig = (body, tenant) => {
  const current = tenant.billing?.toObject?.() ?? tenant.billing ?? {};
  const recurringAmount = Number(body.recurringAmount ?? current.recurringAmount ?? 0);
  const extensionDays = Number(body.extensionDays ?? current.extensionDays ?? 30);
  const taxRate = Number(body.taxRate ?? current.taxRate ?? 0);
  const discountAmount = Number(body.discountAmount ?? current.discountAmount ?? 0);
  const currency = String(body.currency ?? current.currency ?? 'PKR').trim().toUpperCase();
  const cycle = String(body.cycle ?? current.cycle ?? 'monthly').trim();
  const billingEmail = String(body.billingEmail ?? current.billingEmail ?? '').trim().toLowerCase();
  const remindersEnabled = body.remindersEnabled ?? current.remindersEnabled ?? false;
  const paymentInstructions = String(body.paymentInstructions ?? current.paymentInstructions ?? '').trim();

  if (!Number.isFinite(recurringAmount) || recurringAmount < 0) throw Object.assign(new Error('Subscription amount must be zero or greater.'), { statusCode: 422 });
  if (!Number.isInteger(extensionDays) || extensionDays < 1 || extensionDays > 3660) throw Object.assign(new Error('Extension days must be a whole number between 1 and 3660.'), { statusCode: 422 });
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw Object.assign(new Error('Tax rate must be between 0 and 100.'), { statusCode: 422 });
  if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > recurringAmount) throw Object.assign(new Error('Discount cannot exceed the subscription amount.'), { statusCode: 422 });
  if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('Currency must be a three-letter code.'), { statusCode: 422 });
  if (!CYCLES.has(cycle)) throw Object.assign(new Error('Invalid billing cycle.'), { statusCode: 422 });
  if (billingEmail && !EMAIL.test(billingEmail)) throw Object.assign(new Error('Billing email is invalid.'), { statusCode: 422 });
  if (paymentInstructions.length > 2000) throw Object.assign(new Error('Payment instructions cannot exceed 2000 characters.'), { statusCode: 422 });
  if (remindersEnabled === true && recurringAmount <= 0) throw Object.assign(new Error('Set a subscription amount before enabling reminders.'), { statusCode: 422 });

  return {
    recurringAmount,
    extensionDays,
    taxRate,
    discountAmount,
    currency,
    cycle,
    billingEmail,
    remindersEnabled: remindersEnabled === true,
    paymentInstructions,
  };
};

export const getTenantBilling = async (req, res) => {
  requireObjectId(req.params.id, 'tenant ID');
  const tenant = await TenantModel().findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const invoices = await BillingInvoiceModel().find({ tenant: tenant._id }).sort({ issueDate: -1 }).limit(100).lean();
  const invoiceIds = invoices.map((invoice) => invoice._id);
  const emailLogs = invoiceIds.length
    ? await BillingEmailLogModel().find({ invoice: { $in: invoiceIds } }).sort({ createdAt: -1 }).limit(100).lean()
    : [];
  return res.json({
    success: true,
    billing: tenant.billing?.toObject?.() ?? tenant.billing ?? {},
    invoices: invoices.map(sanitizeBillingInvoice),
    emailLogs: emailLogs.map(emailLogJson),
  });
};

export const updateTenantBillingConfig = async (req, res) => {
  requireObjectId(req.params.id, 'tenant ID');
  const tenant = await TenantModel().findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  tenant.billing = {
    ...parseBillingConfig(req.body, tenant),
    updatedAt: new Date(),
    updatedBy: req.admin.email,
  };
  await tenant.save();
  cacheDel(tenantKey(tenant.slug));
  logger.info(`[billing] configuration updated for ${tenant.slug} by ${req.admin.email}`);
  return res.json({ success: true, billing: tenant.billing });
};

export const issueTenantInvoice = async (req, res) => {
  requireObjectId(req.params.id, 'tenant ID');
  const tenant = await TenantModel().findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const { invoice, created } = await ensureRenewalInvoice({
    tenant,
    actor: req.admin.email,
    force: req.body.force === true,
  });
  let emailWarning = null;
  if (req.body.sendNow !== false && !invoice.invoiceSentAt) {
    try {
      await sendBillingEmail({
        invoice,
        type: 'invoice',
        deliveryKey: `${invoice._id}:admin-issue:${Date.now()}`,
        triggeredBy: req.admin.email,
      });
      invoice.invoiceSentAt = new Date();
      invoice.lastReminderAt = new Date();
      invoice.nextReminderAt = invoice.remindersEnabled
        ? new Date(Date.now() + 24 * 60 * 60 * 1000)
        : null;
      invoice.reminderCount += 1;
      invoice.auditTrail.push({ action: 'invoiceEmailed', at: new Date(), by: req.admin.email });
      await invoice.save();
    } catch (error) {
      emailWarning = error.message;
    }
  }
  return res.status(created ? 201 : 200).json({
    success: true,
    created,
    invoice: sanitizeBillingInvoice(invoice),
    emailWarning,
  });
};

export const markSubscriptionInvoicePaid = async (req, res) => {
  requireObjectId(req.params.invoiceId, 'invoice ID');
  const result = await recordInvoicePayment({
    invoiceId: req.params.invoiceId,
    amount: req.body.amount,
    paidAt: req.body.paidAt || new Date(),
    paymentMethod: req.body.paymentMethod,
    paymentReference: req.body.paymentReference,
    paymentNotes: req.body.paymentNotes,
    accessUntil: req.body.accessUntil,
    actor: req.admin.email,
  });
  let emailWarning = null;
  try {
    await sendPaymentConfirmation(result.invoice._id, req.admin.email);
    result.invoice.paymentEmailSentAt = new Date();
  } catch (error) {
    emailWarning = error.message;
  }
  logger.info(`[billing] payment recorded for ${result.invoice.invoiceNumber} by ${req.admin.email}`);
  return res.json({
    success: true,
    invoice: sanitizeBillingInvoice(result.invoice),
    tenant: {
      id: result.tenant._id,
      status: result.tenant.status,
      accessUntil: result.tenant.accessUntil,
    },
    emailWarning,
  });
};

export const voidSubscriptionInvoice = async (req, res) => {
  requireObjectId(req.params.invoiceId, 'invoice ID');
  const invoice = await BillingInvoiceModel().findOneAndUpdate(
    { _id: req.params.invoiceId, status: { $in: ['issued', 'overdue'] } },
    {
      $set: {
        status: 'void',
        renewalKey: `${req.params.invoiceId}:void:${Date.now()}`,
        remindersEnabled: false,
        nextReminderAt: null,
        reminderLeaseUntil: null,
        voidedAt: new Date(),
        voidedBy: req.admin.email,
        voidReason: String(req.body.reason || '').trim(),
      },
      $push: { auditTrail: { action: 'invoiceVoided', at: new Date(), by: req.admin.email, details: { reason: req.body.reason } } },
    },
    { returnDocument: 'after' },
  );
  if (!invoice) return res.status(409).json({ success: false, message: 'Only an issued or overdue invoice can be voided.' });
  return res.json({ success: true, invoice: sanitizeBillingInvoice(invoice) });
};

export const resendSubscriptionInvoice = async (req, res) => {
  requireObjectId(req.params.invoiceId, 'invoice ID');
  const invoice = await BillingInvoiceModel().findById(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ success: false, message: 'Subscription invoice not found.' });
  if (invoice.status === 'void') return res.status(409).json({ success: false, message: 'A void invoice cannot be emailed.' });
  const type = invoice.status === 'paid' ? 'paymentConfirmation' : 'manualResend';
  await sendBillingEmail({
    invoice,
    type,
    deliveryKey: `${invoice._id}:manual-resend:${Date.now()}`,
    triggeredBy: req.admin.email,
  });
  if (type === 'paymentConfirmation') invoice.paymentEmailSentAt = new Date();
  else invoice.invoiceSentAt = invoice.invoiceSentAt || new Date();
  invoice.auditTrail.push({ action: 'emailResent', at: new Date(), by: req.admin.email, details: { type } });
  await invoice.save();
  return res.json({ success: true, invoice: sanitizeBillingInvoice(invoice) });
};

const sendPdf = (res, buffer, filename) => {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Content-Length', String(buffer.length));
  return res.send(buffer);
};

export const downloadSubscriptionInvoice = async (req, res) => {
  requireObjectId(req.params.invoiceId, 'invoice ID');
  const invoice = await BillingInvoiceModel().findById(req.params.invoiceId).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Subscription invoice not found.' });
  return sendPdf(res, await generateInvoicePdf(invoice), `${invoice.invoiceNumber}.pdf`);
};

export const downloadSubscriptionReceipt = async (req, res) => {
  requireObjectId(req.params.invoiceId, 'invoice ID');
  const invoice = await BillingInvoiceModel().findById(req.params.invoiceId).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Subscription invoice not found.' });
  if (invoice.status !== 'paid' || !invoice.receiptNumber) return res.status(409).json({ success: false, message: 'Receipt is available after payment.' });
  return sendPdf(res, await generateReceiptPdf(invoice), `${invoice.receiptNumber}.pdf`);
};
