import { sendEmail } from '../../services/mailtrap.js';
import { BillingEmailLogModel } from '../models/BillingEmailLog.js';
import { BillingInvoiceModel } from '../models/BillingInvoice.js';
import { generateInvoicePdf, generateReceiptPdf } from './billingPdf.service.js';
import { getDaysRemaining } from './billing.service.js';

const money = (invoice, value) => `${invoice.currency || 'PKR'} ${Number(value || 0).toLocaleString('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const dateText = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: process.env.BILLING_TIMEZONE || 'Asia/Karachi',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
}).format(new Date(value));

const templateVariables = (invoice, copy, type) => {
  const bank = invoice.bankDetails || {};
  return {
    subject_line: copy.subject,
    document_type: type === 'paymentConfirmation' ? 'Payment receipt' : 'Subscription invoice',
    is_payment_confirmation: type === 'paymentConfirmation',
    is_payment_reminder: type === 'reminder' || type === 'manualResend',
    owner_name: invoice.ownerName || invoice.restaurantName,
    restaurant_name: invoice.restaurantName,
    heading: copy.heading,
    intro: copy.intro,
    callout: copy.callout,
    invoice_number: invoice.invoiceNumber,
    receipt_number: invoice.receiptNumber || '',
    currency: invoice.currency || 'PKR',
    total: money(invoice, invoice.total),
    amount_due: money(invoice, invoice.balance),
    amount_paid: money(invoice, invoice.amountPaid),
    due_date: dateText(invoice.dueDate),
    access_until: dateText(invoice.status === 'paid' ? invoice.accessGrantedUntil : invoice.accessUntilBefore),
    attachment_note: invoice.status === 'paid'
      ? 'Your paid invoice and receipt are attached as PDF files.'
      : 'Your subscription invoice is attached as a PDF file.',
    has_bank_details: bank.active === true,
    bank_name: bank.bankName || '',
    account_title: bank.accountTitle || '',
    account_number: bank.accountNumber || '',
    iban: bank.iban || '',
    branch_name: bank.branchName || '',
    branch_code: bank.branchCode || '',
    swift_code: bank.swiftCode || '',
    bank_currency: bank.currency || invoice.currency || 'PKR',
    bank_payment_notes: bank.paymentNotes || '',
    has_payment_instructions: Boolean(invoice.paymentInstructions),
    payment_instructions: invoice.paymentInstructions || '',
  };
};

const emailCopy = (invoice, type, now) => {
  const remaining = getDaysRemaining(invoice.accessUntilBefore, now);
  if (type === 'paymentConfirmation') {
    return {
      subject: `Payment received - ${invoice.receiptNumber} - ${invoice.restaurantName}`,
      heading: 'Payment received - thank you',
      intro: `We received ${money(invoice, invoice.amountPaid)} for your Cenciss subscription.`,
      callout: `Your access is active until ${dateText(invoice.accessGrantedUntil)}.`,
    };
  }
  const timing = remaining.millisecondsRemaining > 0
    ? `${remaining.daysRemaining} day${remaining.daysRemaining === 1 ? '' : 's'} remaining`
    : `${Math.abs(remaining.daysRemaining)} day${Math.abs(remaining.daysRemaining) === 1 ? '' : 's'} overdue`;
  const initial = type === 'invoice';
  return {
    subject: `${initial ? 'Subscription invoice' : 'Payment reminder'} - ${invoice.invoiceNumber} - ${money(invoice, invoice.balance)}`,
    heading: initial ? 'Your subscription renewal invoice' : 'Subscription payment reminder',
    intro: `Invoice ${invoice.invoiceNumber} has an outstanding balance of ${money(invoice, invoice.balance)}.`,
    callout: `Subscription expiry: ${dateText(invoice.accessUntilBefore)} (${timing}).`,
  };
};

const acquireDeliveryLog = async ({ invoice, type, deliveryKey, triggeredBy }) => {
  try {
    return await BillingEmailLogModel().create({
      invoice: invoice._id,
      tenant: invoice.tenant,
      tenantSlug: invoice.tenantSlug,
      deliveryKey,
      type,
      recipient: invoice.billingEmail,
      status: 'processing',
      attemptedAt: new Date(),
      triggeredBy,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await BillingEmailLogModel().findOne({ deliveryKey });
    if (existing?.status === 'sent') return existing;
    if (!existing) throw error;
    existing.status = 'processing';
    existing.error = '';
    existing.attemptedAt = new Date();
    existing.triggeredBy = triggeredBy;
    await existing.save();
    return existing;
  }
};

export const sendBillingEmail = async ({
  invoice: invoiceInput,
  type,
  deliveryKey,
  triggeredBy = 'system',
  now = new Date(),
}) => {
  const invoice = invoiceInput?.toObject?.() ?? invoiceInput;
  if (!invoice?._id) throw new Error('Billing invoice is required.');
  if (!invoice.billingEmail) throw new Error('Billing recipient email is missing.');
  const log = await acquireDeliveryLog({ invoice, type, deliveryKey, triggeredBy });
  if (log.status === 'sent') return { log, skipped: true };

  try {
    const invoicePdf = await generateInvoicePdf(invoice);
    const attachments = [{
      filename: `${invoice.invoiceNumber}.pdf`,
      type: 'application/pdf',
      disposition: 'attachment',
      content: invoicePdf,
    }];
    if (type === 'paymentConfirmation') {
      const receiptPdf = await generateReceiptPdf(invoice);
      attachments.push({
        filename: `${invoice.receiptNumber}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
        content: receiptPdf,
      });
    }
    const copy = emailCopy(invoice, type, now);
    const templateUuid = String(process.env.BILLING_MAILTRAP_TEMPLATE_UUID || '').trim();
    if (!templateUuid) {
      throw new Error('BILLING_MAILTRAP_TEMPLATE_UUID is not configured. Create the billing template in Mailtrap and add its UUID.');
    }
    const response = await sendEmail({
      to: invoice.billingEmail,
      attachments,
      templateUuid,
      templateVariables: templateVariables(invoice, copy, type),
    });
    log.status = 'sent';
    log.sentAt = new Date();
    log.providerMessageIds = response?.message_ids || [];
    log.error = '';
    await log.save();
    return { log, response, skipped: false };
  } catch (error) {
    log.status = 'failed';
    log.error = String(error?.message || error).slice(0, 1000);
    await log.save();
    throw error;
  }
};

export const sendPaymentConfirmation = async (invoiceId, triggeredBy = 'system') => {
  const invoice = await BillingInvoiceModel().findById(invoiceId);
  if (!invoice) throw new Error('Subscription invoice not found.');
  if (invoice.status !== 'paid' || !invoice.receiptNumber) throw new Error('Only a paid invoice can send a receipt.');
  const result = await sendBillingEmail({
    invoice,
    type: 'paymentConfirmation',
    deliveryKey: `${invoice._id}:payment-confirmation`,
    triggeredBy,
  });
  if (!result.skipped) {
    invoice.paymentEmailSentAt = new Date();
    await invoice.save();
  }
  return result;
};

export default { sendBillingEmail, sendPaymentConfirmation };
