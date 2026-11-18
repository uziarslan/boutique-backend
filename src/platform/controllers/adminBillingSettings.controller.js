import { getPlatformBillingSettings } from '../models/PlatformBillingSettings.js';
import { BillingInvoiceModel } from '../models/BillingInvoice.js';
import logger from '../../utils/logger.js';

const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);

const sanitize = (settings) => {
  const row = settings?.toObject?.() ?? settings ?? {};
  return {
    bankDetails: {
      active: row.bankDetails?.active === true,
      bankName: row.bankDetails?.bankName || '',
      accountTitle: row.bankDetails?.accountTitle || '',
      accountNumber: row.bankDetails?.accountNumber || '',
      iban: row.bankDetails?.iban || '',
      branchName: row.bankDetails?.branchName || '',
      branchCode: row.bankDetails?.branchCode || '',
      swiftCode: row.bankDetails?.swiftCode || '',
      currency: row.bankDetails?.currency || 'PKR',
      paymentNotes: row.bankDetails?.paymentNotes || '',
    },
    updatedAt: row.updatedAt || null,
    updatedBy: row.updatedBy || '',
  };
};

export const getAdminBillingSettings = async (_req, res) => {
  const settings = await getPlatformBillingSettings();
  return res.json({ success: true, data: sanitize(settings) });
};

export const updateAdminBillingSettings = async (req, res) => {
  const input = req.body?.bankDetails || req.body || {};
  const bankDetails = {
    active: input.active === true,
    bankName: clean(input.bankName),
    accountTitle: clean(input.accountTitle),
    accountNumber: clean(input.accountNumber),
    iban: clean(input.iban, 80).replace(/\s+/g, '').toUpperCase(),
    branchName: clean(input.branchName),
    branchCode: clean(input.branchCode, 80),
    swiftCode: clean(input.swiftCode, 80).replace(/\s+/g, '').toUpperCase(),
    currency: clean(input.currency || 'PKR', 3).toUpperCase(),
    paymentNotes: clean(input.paymentNotes, 1000),
  };

  if (!/^[A-Z]{3}$/.test(bankDetails.currency)) {
    return res.status(422).json({ success: false, message: 'Bank currency must be a three-letter code.' });
  }
  if (bankDetails.active) {
    if (!bankDetails.bankName || !bankDetails.accountTitle) {
      return res.status(422).json({ success: false, message: 'Bank name and account title are required when sharing bank details.' });
    }
    if (!bankDetails.accountNumber && !bankDetails.iban) {
      return res.status(422).json({ success: false, message: 'Enter an account number or IBAN.' });
    }
  }

  const settings = await getPlatformBillingSettings();
  settings.bankDetails = bankDetails;
  settings.updatedBy = req.admin.email;
  await settings.save();
  const outstandingUpdate = await BillingInvoiceModel().updateMany(
    { status: { $in: ['issued', 'overdue'] }, balance: { $gt: 0 } },
    {
      $set: { bankDetails },
      $push: {
        auditTrail: {
          action: 'bankDetailsRefreshed',
          at: new Date(),
          by: req.admin.email,
        },
      },
    },
  );
  logger.info(`[billing] platform bank details updated by ${req.admin.email}`);
  return res.json({
    success: true,
    data: sanitize(settings),
    updatedOutstandingInvoices: outstandingUpdate.modifiedCount || 0,
  });
};
