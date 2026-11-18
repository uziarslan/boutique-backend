import { BillingSequenceModel } from '../models/BillingSequence.js';
import { BillingInvoiceModel } from '../models/BillingInvoice.js';
import { TenantModel } from '../models/Tenant.js';
import { getPlatformBillingSettings } from '../models/PlatformBillingSettings.js';
import { cacheDel, tenantKey } from '../../utils/requestCache.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const calculateInvoiceAmounts = ({ amount, discountAmount = 0, taxRate = 0 }) => {
  const subtotal = roundMoney(Math.max(0, Number(amount) || 0));
  const discount = roundMoney(Math.min(subtotal, Math.max(0, Number(discountAmount) || 0)));
  const taxable = roundMoney(subtotal - discount);
  const rate = Math.min(100, Math.max(0, Number(taxRate) || 0));
  const taxAmount = roundMoney(taxable * rate / 100);
  const total = roundMoney(taxable + taxAmount);
  return { subtotal, discountAmount: discount, taxRate: rate, taxAmount, total };
};

export const addDays = (date, days) => new Date(new Date(date).getTime() + Number(days) * DAY_MS);

export const getDaysRemaining = (accessUntil, now = new Date()) => {
  const millisecondsRemaining = new Date(accessUntil).getTime() - new Date(now).getTime();
  return {
    millisecondsRemaining,
    daysRemaining: millisecondsRemaining > 0
      ? Math.ceil(millisecondsRemaining / DAY_MS)
      : Math.floor(millisecondsRemaining / DAY_MS),
  };
};

const nextNumber = async (kind, at = new Date()) => {
  const year = at.getUTCFullYear();
  const key = `${kind}:${year}`;
  const sequence = await BillingSequenceModel().findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const prefix = kind === 'receipt' ? 'RCT' : 'INV';
  return `CEN-${prefix}-${year}-${String(sequence.seq).padStart(6, '0')}`;
};

export const nextInvoiceNumber = (at) => nextNumber('invoice', at);
export const nextReceiptNumber = (at) => nextNumber('receipt', at);

export const sanitizeBillingInvoice = (invoice) => {
  if (!invoice) return null;
  const row = invoice.toObject?.() ?? invoice;
  return {
    id: row._id,
    tenant: row.tenant,
    tenantSlug: row.tenantSlug,
    invoiceNumber: row.invoiceNumber,
    receiptNumber: row.receiptNumber,
    restaurantName: row.restaurantName,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    billingEmail: row.billingEmail,
    bankDetails: row.bankDetails || {},
    currency: row.currency,
    lineItems: row.lineItems || [],
    subtotal: row.subtotal,
    discountAmount: row.discountAmount,
    taxRate: row.taxRate,
    taxAmount: row.taxAmount,
    total: row.total,
    amountPaid: row.amountPaid,
    balance: row.balance,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    accessUntilBefore: row.accessUntilBefore,
    projectedAccessUntil: row.projectedAccessUntil,
    accessGrantedUntil: row.accessGrantedUntil,
    paymentInstructions: row.paymentInstructions,
    status: row.status,
    paidAt: row.paidAt,
    paymentMethod: row.paymentMethod,
    paymentReference: row.paymentReference,
    paymentNotes: row.paymentNotes,
    remindersEnabled: row.remindersEnabled,
    reminderCount: row.reminderCount,
    lastReminderAt: row.lastReminderAt,
    nextReminderAt: row.nextReminderAt,
    lastReminderError: row.lastReminderError,
    invoiceSentAt: row.invoiceSentAt,
    paymentEmailSentAt: row.paymentEmailSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const ensureRenewalInvoice = async ({
  tenant,
  actor = 'system',
  now = new Date(),
  force = false,
}) => {
  const tenantRow = tenant?.toObject?.() ?? tenant;
  if (!tenantRow?._id) throw new Error('Tenant is required.');
  if (!tenantRow.accessUntil || Number.isNaN(new Date(tenantRow.accessUntil).getTime())) {
    const error = new Error('Set a valid subscription access date before issuing an invoice.');
    error.statusCode = 422;
    throw error;
  }

  const config = tenantRow.billing || {};
  const amount = Number(config.recurringAmount) || 0;
  if (amount <= 0) {
    const error = new Error('Set the restaurant subscription amount before issuing an invoice.');
    error.statusCode = 422;
    throw error;
  }

  const accessUntil = new Date(tenantRow.accessUntil);
  const baseRenewalKey = `${tenantRow._id}:${accessUntil.toISOString()}`;
  if (!force) {
    const existing = await BillingInvoiceModel().findOne({
      renewalKey: baseRenewalKey,
      status: { $ne: 'void' },
    });
    if (existing) return { invoice: existing, created: false };
  }

  const issueDate = new Date(now);
  const extensionDays = Math.max(1, Number(config.extensionDays) || 30);
  const projectionBase = accessUntil.getTime() > issueDate.getTime() ? accessUntil : issueDate;
  const projectedAccessUntil = addDays(projectionBase, extensionDays);
  const totals = calculateInvoiceAmounts({
    amount,
    discountAmount: config.discountAmount,
    taxRate: config.taxRate,
  });
  if (totals.total <= 0) {
    const error = new Error('The subscription invoice total must be greater than zero.');
    error.statusCode = 422;
    throw error;
  }

  const invoiceNumber = await nextInvoiceNumber(issueDate);
  const platformSettings = await getPlatformBillingSettings();
  const bankDetails = platformSettings.bankDetails?.toObject?.()
    ?? platformSettings.bankDetails
    ?? {};
  const cycleLabel = ({ monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', custom: 'Custom' })[config.cycle] || 'Monthly';
  const renewalKey = force ? `${baseRenewalKey}:r:${invoiceNumber}` : baseRenewalKey;

  try {
    const invoice = await BillingInvoiceModel().create({
      tenant: tenantRow._id,
      tenantSlug: tenantRow.slug,
      renewalKey,
      invoiceNumber,
      restaurantName: tenantRow.outletName,
      ownerName: tenantRow.ownerName || '',
      ownerEmail: tenantRow.ownerEmail,
      billingEmail: String(config.billingEmail || tenantRow.ownerEmail).trim().toLowerCase(),
      bankDetails,
      currency: String(config.currency || 'PKR').toUpperCase(),
      lineItems: [{
        description: `${cycleLabel} Cenciss subscription renewal (${extensionDays} days)`,
        quantity: 1,
        unitPrice: totals.subtotal,
        amount: totals.subtotal,
      }],
      ...totals,
      amountPaid: 0,
      balance: totals.total,
      issueDate,
      dueDate: accessUntil,
      accessUntilBefore: accessUntil,
      projectedAccessUntil,
      paymentInstructions: config.paymentInstructions || '',
      status: accessUntil.getTime() <= issueDate.getTime() ? 'overdue' : 'issued',
      remindersEnabled: config.remindersEnabled === true,
      nextReminderAt: config.remindersEnabled === true ? issueDate : null,
      createdBy: actor,
      auditTrail: [{ action: 'invoiceIssued', at: issueDate, by: actor, details: { force } }],
    });
    return { invoice, created: true };
  } catch (error) {
    if (!force && error?.code === 11000) {
      const existing = await BillingInvoiceModel().findOne({ renewalKey: baseRenewalKey });
      if (existing) return { invoice: existing, created: false };
    }
    throw error;
  }
};

export const getTenantBillingStatus = async (tenant, now = new Date()) => {
  const tenantRow = tenant?.toObject?.() ?? tenant;
  const remaining = tenantRow?.accessUntil
    ? getDaysRemaining(tenantRow.accessUntil, now)
    : { daysRemaining: null, millisecondsRemaining: null };
  const invoice = tenantRow?._id
    ? await BillingInvoiceModel().findOne({
        tenant: tenantRow._id,
        status: { $in: ['issued', 'overdue'] },
        balance: { $gt: 0 },
      }).sort({ issueDate: -1 }).lean()
    : null;

  return {
    showWarning: remaining.millisecondsRemaining > 0 && remaining.daysRemaining <= 7,
    daysRemaining: remaining.daysRemaining,
    millisecondsRemaining: remaining.millisecondsRemaining,
    accessUntil: tenantRow?.accessUntil || null,
    status: tenantRow?.status || null,
    outstandingAmount: invoice?.balance || 0,
    currency: invoice?.currency || tenantRow?.billing?.currency || 'PKR',
    invoice: sanitizeBillingInvoice(invoice),
  };
};

export const recordInvoicePayment = async ({
  invoiceId,
  amount,
  paidAt = new Date(),
  paymentMethod,
  paymentReference,
  paymentNotes,
  accessUntil,
  actor,
}) => {
  const invoice = await BillingInvoiceModel().findById(invoiceId);
  if (!invoice) {
    const error = new Error('Subscription invoice not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!['issued', 'overdue'].includes(invoice.status)) {
    const error = new Error(`Invoice is already ${invoice.status}.`);
    error.statusCode = 409;
    throw error;
  }
  const paidAmount = roundMoney(amount);
  if (Math.abs(paidAmount - roundMoney(invoice.balance)) > 0.009) {
    const error = new Error(`Payment must match the outstanding balance of ${invoice.currency} ${roundMoney(invoice.balance).toFixed(2)}.`);
    error.statusCode = 422;
    throw error;
  }
  const paymentDate = new Date(paidAt);
  if (Number.isNaN(paymentDate.getTime())) {
    const error = new Error('Enter a valid payment date.');
    error.statusCode = 422;
    throw error;
  }
  const grantedUntil = new Date(accessUntil || invoice.projectedAccessUntil);
  if (Number.isNaN(grantedUntil.getTime()) || grantedUntil.getTime() <= paymentDate.getTime()) {
    const error = new Error('The new access date must be after the payment date.');
    error.statusCode = 422;
    throw error;
  }

  const receiptNumber = await nextReceiptNumber(paymentDate);
  const previousStatus = invoice.status;
  const updated = await BillingInvoiceModel().findOneAndUpdate(
    { _id: invoice._id, status: { $in: ['issued', 'overdue'] } },
    {
      $set: {
        status: 'paid',
        amountPaid: paidAmount,
        balance: 0,
        paidAt: paymentDate,
        paymentMethod: String(paymentMethod || '').trim(),
        paymentReference: String(paymentReference || '').trim(),
        paymentNotes: String(paymentNotes || '').trim(),
        accessGrantedUntil: grantedUntil,
        receiptNumber,
        paidBy: actor,
        remindersEnabled: false,
        nextReminderAt: null,
        reminderLeaseUntil: null,
      },
      $push: {
        auditTrail: {
          action: 'paymentRecorded',
          at: new Date(),
          by: actor,
          details: { amount: paidAmount, accessUntil: grantedUntil },
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    const error = new Error('Invoice payment was already recorded by another request.');
    error.statusCode = 409;
    throw error;
  }

  try {
    const tenant = await TenantModel().findByIdAndUpdate(
      invoice.tenant,
      { status: 'active', accessUntil: grantedUntil },
      { returnDocument: 'after' },
    );
    if (!tenant) throw new Error('Tenant no longer exists.');
    cacheDel(tenantKey(tenant.slug));
    return { invoice: updated, tenant };
  } catch (error) {
    await BillingInvoiceModel().updateOne(
      { _id: updated._id, receiptNumber },
      {
        $set: {
          status: previousStatus,
          amountPaid: 0,
          balance: invoice.balance,
          paidAt: null,
          paymentMethod: '',
          paymentReference: '',
          paymentNotes: '',
          accessGrantedUntil: null,
          paidBy: '',
          remindersEnabled: invoice.remindersEnabled,
          nextReminderAt: invoice.nextReminderAt,
        },
        $unset: { receiptNumber: '' },
        $push: {
          auditTrail: { action: 'paymentRolledBack', at: new Date(), by: actor, details: { reason: error.message } },
        },
      },
    );
    throw error;
  }
};
