import mongoose from 'mongoose';
import { BillingInvoiceModel } from '../platform/models/BillingInvoice.js';
import { getTenantBillingStatus, sanitizeBillingInvoice } from '../platform/services/billing.service.js';
import { generateInvoicePdf, generateReceiptPdf } from '../platform/services/billingPdf.service.js';

const mayViewBillingDocuments = (role) => ['owner', 'financeManager'].includes(role);

export const getMyBillingStatus = async (req, res) => {
  const status = await getTenantBillingStatus(req.tenant);
  const canViewDocuments = mayViewBillingDocuments(req.user.role);
  return res.json({
    success: true,
    data: {
      ...status,
      // Every management user may see the expiry warning, but negotiated
      // amounts and invoice details are limited to owner/finance roles.
      outstandingAmount: canViewDocuments ? status.outstandingAmount : 0,
      invoice: canViewDocuments ? status.invoice : null,
      canViewDocuments,
    },
  });
};

export const listMySubscriptionInvoices = async (req, res) => {
  if (!mayViewBillingDocuments(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Owner or finance manager access required.' });
  }
  const invoices = await BillingInvoiceModel().find({ tenant: req.tenant._id })
    .sort({ issueDate: -1 })
    .limit(100)
    .lean();
  return res.json({ success: true, data: invoices.map(sanitizeBillingInvoice) });
};

const loadMyInvoice = async (req, res) => {
  if (!mayViewBillingDocuments(req.user.role)) {
    res.status(403).json({ success: false, message: 'Owner or finance manager access required.' });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.invoiceId)) {
    res.status(400).json({ success: false, message: 'Invalid invoice ID.' });
    return null;
  }
  const invoice = await BillingInvoiceModel().findOne({ _id: req.params.invoiceId, tenant: req.tenant._id }).lean();
  if (!invoice) {
    res.status(404).json({ success: false, message: 'Subscription invoice not found.' });
    return null;
  }
  return invoice;
};

const sendPdf = (res, buffer, filename) => {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Content-Length', String(buffer.length));
  return res.send(buffer);
};

export const downloadMySubscriptionInvoice = async (req, res) => {
  const invoice = await loadMyInvoice(req, res);
  if (!invoice) return undefined;
  return sendPdf(res, await generateInvoicePdf(invoice), `${invoice.invoiceNumber}.pdf`);
};

export const downloadMySubscriptionReceipt = async (req, res) => {
  const invoice = await loadMyInvoice(req, res);
  if (!invoice) return undefined;
  if (invoice.status !== 'paid' || !invoice.receiptNumber) {
    return res.status(409).json({ success: false, message: 'Receipt is available after payment.' });
  }
  return sendPdf(res, await generateReceiptPdf(invoice), `${invoice.receiptNumber}.pdf`);
};
