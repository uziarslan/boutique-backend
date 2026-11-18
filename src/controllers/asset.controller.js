import mongoose from 'mongoose';
import Asset from '../models/Asset.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetMovement from '../models/AssetMovement.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import JournalEntry from '../models/JournalEntry.js';
import Outlet from '../models/Outlet.js';
import {
  enabledAssetAuditOutletIds,
  requireAssetAuditOutlet,
} from '../services/assetFeature.service.js';
import { ensureAssetDefaults } from '../services/assetDefaults.service.js';

const round2 = (value) => Number((Number(value) || 0).toFixed(2));
const isId = (value) => mongoose.isValidObjectId(value);
const populatedAsset = (query) => query
  .populate('category')
  .populate('outlet', 'name code isActive')
  .populate('custodian', 'name email')
  .populate('vendor', 'name code')
  .populate('purchase', 'purchaseNumber vendorInvoiceNumber purchaseDate')
  .populate('acquisitionJournalEntry', 'entryNumber date sourcePath')
  .populate('accounts.asset accounts.accumulatedDepreciation accounts.depreciationExpense accounts.lossOnDisposal accounts.gainOnDisposal');

const ACCOUNT_RULES = {
  asset: { type: 'asset', label: 'Asset account' },
  accumulatedDepreciation: { type: 'asset', normalBalance: 'credit', label: 'Accumulated Depreciation account' },
  depreciationExpense: { type: 'expense', label: 'Depreciation Expense account' },
  lossOnDisposal: { type: 'expense', label: 'Loss/Write-off account' },
  gainOnDisposal: { type: 'revenue', label: 'Disposal Gain account' },
};

const validateAccountMappings = async (raw = {}, { requireAsset = true } = {}) => {
  const ids = Object.values(raw).filter(isId);
  const accounts = ids.length
    ? await ChartOfAccounts.find({ _id: { $in: ids }, isActive: true }).lean()
    : [];
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const mapped = {};

  for (const [key, rule] of Object.entries(ACCOUNT_RULES)) {
    const value = raw?.[key];
    if (!value) continue;
    if (!isId(value) || !byId.has(String(value))) {
      const err = new Error(`${rule.label} is invalid or inactive.`);
      err.statusCode = 422;
      throw err;
    }
    const account = byId.get(String(value));
    if (account.type !== rule.type || (rule.normalBalance && account.normalBalance !== rule.normalBalance)) {
      const err = new Error(
        `${rule.label} must be ${rule.type}${rule.normalBalance ? ` with a ${rule.normalBalance} normal balance` : ''}.`,
      );
      err.statusCode = 422;
      throw err;
    }
    mapped[key] = account._id;
  }

  if (requireAsset && !mapped.asset) {
    const err = new Error('A fixed-asset Chart of Accounts head is required.');
    err.statusCode = 422;
    throw err;
  }
  return mapped;
};

const categoryPayload = async (body, userId, existing = null) => {
  const code = String(body.code ?? existing?.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!code || !name) {
    const err = new Error('Category code and name are required.');
    err.statusCode = 422;
    throw err;
  }
  const accounts = await validateAccountMappings(body.accounts ?? existing?.accounts ?? {});
  return {
    code,
    name,
    description: String(body.description ?? existing?.description ?? '').trim(),
    trackingMode: body.trackingMode === 'bulk' ? 'bulk' : 'serialized',
    defaultUnit: String(body.defaultUnit ?? existing?.defaultUnit ?? 'unit').trim() || 'unit',
    defaultUsefulLifeMonths: Math.max(1, Number(body.defaultUsefulLifeMonths ?? existing?.defaultUsefulLifeMonths) || 60),
    defaultResidualValuePercent: Math.min(
      100,
      Math.max(0, Number(body.defaultResidualValuePercent ?? existing?.defaultResidualValuePercent) || 0),
    ),
    depreciationMethod: body.depreciationMethod === 'none' ? 'none' : 'straightLine',
    auditFrequencyDays: Math.max(1, Number(body.auditFrequencyDays ?? existing?.auditFrequencyDays) || 90),
    capitalisationThreshold: Math.max(0, Number(body.capitalisationThreshold ?? existing?.capitalisationThreshold) || 0),
    accounts,
    isActive: body.isActive ?? existing?.isActive ?? true,
    updatedBy: userId,
  };
};

export const getAssetMeta = async (req, res) => {
  const enabledIds = enabledAssetAuditOutletIds(req.tenant).filter(isId);
  const outlets = enabledIds.length
    ? await Outlet.find({ _id: { $in: enabledIds }, isActive: true })
      .select('name code timezone isActive')
      .sort({ name: 1 })
      .lean()
    : [];
  return res.json({ success: true, data: { outlets } });
};

export const getAssetAccountOptions = async (req, res) => {
  await ensureAssetDefaults();
  const accounts = await ChartOfAccounts.find({
    isActive: true,
    type: { $in: ['asset', 'expense', 'revenue'] },
  }).select('code name type subType normalBalance').sort({ code: 1 }).lean();
  return res.json({ success: true, data: accounts });
};

export const listAssetCategories = async (req, res) => {
  await ensureAssetDefaults();
  const filter = {};
  if (req.query.active !== 'all') filter.isActive = req.query.active === 'false' ? false : true;
  const categories = await AssetCategory.find(filter)
    .populate('accounts.asset accounts.accumulatedDepreciation accounts.depreciationExpense accounts.lossOnDisposal accounts.gainOnDisposal')
    .sort({ name: 1 })
    .lean();
  return res.json({ success: true, data: categories });
};

export const createAssetCategory = async (req, res) => {
  const payload = await categoryPayload(req.body, req.user.id);
  const category = await AssetCategory.create({ ...payload, createdBy: req.user.id });
  req.auditRecordId = category._id;
  req.auditAfter = category.toObject();
  return res.status(201).json({ success: true, data: category });
};

export const updateAssetCategory = async (req, res) => {
  const category = await AssetCategory.findById(req.params.id);
  if (!category) return res.status(404).json({ success: false, message: 'Asset category not found.' });
  const before = category.toObject();
  const payload = await categoryPayload(req.body, req.user.id, category);
  Object.assign(category, payload);
  await category.save();
  req.auditRecordId = category._id;
  req.auditBefore = before;
  req.auditAfter = category.toObject();
  return res.json({ success: true, data: category });
};

export const listAssets = async (req, res) => {
  const {
    outlet, category, status, condition, q, page = 1, limit = 30,
  } = req.query;
  const enabledIds = enabledAssetAuditOutletIds(req.tenant).filter(isId);
  const requestedOutlet = isId(outlet) ? String(outlet) : null;
  if (requestedOutlet && !requireAssetAuditOutlet(req, res, requestedOutlet)) return;

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 30));
  const filter = {
    outlet: { $in: requestedOutlet ? [requestedOutlet] : enabledIds },
  };
  if (isId(category)) filter.category = category;
  if (status) filter.status = status;
  if (condition) filter.condition = condition;
  if (String(q || '').trim()) {
    const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    filter.$or = [{ assetNumber: re }, { name: re }, { serialNumber: re }, { location: re }];
  }

  const [assets, total, summaryRows] = await Promise.all([
    populatedAsset(
      Asset.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize),
    ).lean({ virtuals: true }),
    Asset.countDocuments(filter),
    Asset.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          assets: { $sum: 1 },
          quantity: { $sum: '$quantity' },
          grossCost: { $sum: { $ifNull: ['$grossCarryingAmount', '$originalCost'] } },
          accumulatedDepreciation: { $sum: '$accumulatedDepreciation' },
          dueForAudit: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$nextAuditDueAt', null] }, { $lte: ['$nextAuditDueAt', new Date()] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  const summary = summaryRows[0] || {
    assets: 0, quantity: 0, grossCost: 0, accumulatedDepreciation: 0, dueForAudit: 0,
  };
  summary.netBookValue = round2(summary.grossCost - summary.accumulatedDepreciation);

  return res.json({
    success: true,
    data: {
      assets,
      total,
      page: pageNum,
      pages: Math.ceil(total / pageSize),
      summary,
    },
  });
};

export const getAsset = async (req, res) => {
  const asset = await populatedAsset(Asset.findById(req.params.id)).lean({ virtuals: true });
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  if (!requireAssetAuditOutlet(req, res, asset.outlet?._id || asset.outlet)) return;
  const movements = await AssetMovement.find({ asset: asset._id })
    .populate('user', 'name email')
    .populate('fromOutlet toOutlet', 'name code')
    .populate('journalEntry', 'entryNumber date')
    .sort({ at: -1 })
    .lean();
  return res.json({ success: true, data: { ...asset, movements } });
};

export const createAsset = async (req, res) => {
  const outletId = req.body.outlet;
  if (!isId(outletId)) return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  if (!requireAssetAuditOutlet(req, res, outletId)) return;
  const [outlet, category] = await Promise.all([
    Outlet.findOne({ _id: outletId, isActive: true }).lean(),
    AssetCategory.findOne({ _id: req.body.category, isActive: true }),
  ]);
  if (!outlet) return res.status(422).json({ success: false, message: 'Outlet is invalid or inactive.' });
  if (!category) return res.status(422).json({ success: false, message: 'Asset category is invalid or inactive.' });

  const trackingMode = category.trackingMode;
  const quantity = trackingMode === 'serialized'
    ? 1
    : Math.max(0, Number(req.body.quantity) || 0);
  if (quantity <= 0) return res.status(422).json({ success: false, message: 'Asset quantity must be greater than zero.' });
  const unitCost = Math.max(0, Number(req.body.originalUnitCost) || 0);
  const originalCost = round2(unitCost * quantity);
  const residualValue = req.body.residualValue !== undefined
    ? Math.max(0, Number(req.body.residualValue) || 0)
    : round2(originalCost * (Number(category.defaultResidualValuePercent || 0) / 100));
  const acquisitionDate = req.body.acquisitionDate ? new Date(req.body.acquisitionDate) : new Date();
  const nextAuditDueAt = new Date(
    acquisitionDate.getTime() + Number(category.auditFrequencyDays || 90) * 86400000,
  );

  const asset = await Asset.create({
    name: String(req.body.name || '').trim(),
    category: category._id,
    trackingMode,
    outlet: outletId,
    location: req.body.location,
    custodian: isId(req.body.custodian) ? req.body.custodian : null,
    custodianName: req.body.custodianName,
    serialNumber: trackingMode === 'serialized' ? String(req.body.serialNumber || '').trim() : '',
    modelNumber: req.body.modelNumber,
    manufacturer: req.body.manufacturer,
    unit: req.body.unit || category.defaultUnit,
    originalQuantity: quantity,
    quantity,
    originalUnitCost: unitCost,
    originalCost,
    grossCarryingAmount: originalCost,
    residualValue: Math.min(originalCost, residualValue),
    acquisitionDate,
    depreciationStartDate: req.body.depreciationStartDate
      ? new Date(req.body.depreciationStartDate)
      : acquisitionDate,
    usefulLifeMonths: Math.max(1, Number(req.body.usefulLifeMonths) || category.defaultUsefulLifeMonths),
    depreciationMethod: req.body.depreciationMethod || category.depreciationMethod,
    condition: req.body.condition || 'good',
    status: req.body.status || 'active',
    accounts: category.accounts.toObject?.() ?? category.accounts,
    accountingLinked: req.body.accountingLinked === true,
    source: req.body.source === 'openingImport' ? 'openingImport' : 'manual',
    warrantyExpiresAt: req.body.warrantyExpiresAt || null,
    attachmentUrls: Array.isArray(req.body.attachmentUrls) ? req.body.attachmentUrls : [],
    notes: req.body.notes,
    nextAuditDueAt,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  const movement = await AssetMovement.create({
    asset: asset._id,
    outlet: asset.outlet,
    type: asset.source === 'openingImport' ? 'openingImport' : 'acquisition',
    quantityBefore: 0,
    quantityChange: asset.quantity,
    quantityAfter: asset.quantity,
    conditionAfter: asset.condition,
    locationAfter: asset.location,
    amount: asset.originalCost,
    reason: asset.source === 'openingImport' ? 'Opening asset register import' : 'Asset created',
    user: req.user.id,
  });

  req.auditRecordId = asset._id;
  req.auditAfter = asset.toObject();
  return res.status(201).json({ success: true, data: { asset, movement } });
};

export const updateAsset = async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  if (!requireAssetAuditOutlet(req, res, asset.outlet)) return;
  const before = asset.toObject();
  const allowed = [
    'name',
    'location',
    'custodianName',
    'serialNumber',
    'modelNumber',
    'manufacturer',
    'unit',
    'warrantyExpiresAt',
    'attachmentUrls',
    'notes',
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) asset[key] = req.body[key];
  }
  if (req.body.custodian !== undefined) {
    asset.custodian = isId(req.body.custodian) ? req.body.custodian : null;
  }
  if (req.body.condition && req.body.condition !== asset.condition) {
    await AssetMovement.create({
      asset: asset._id,
      outlet: asset.outlet,
      type: 'conditionChange',
      quantityBefore: asset.quantity,
      quantityAfter: asset.quantity,
      conditionBefore: asset.condition,
      conditionAfter: req.body.condition,
      locationBefore: asset.location,
      locationAfter: req.body.location ?? asset.location,
      reason: String(req.body.changeReason || 'Asset details updated'),
      user: req.user.id,
    });
    asset.condition = req.body.condition;
    if (req.body.condition === 'underRepair') asset.status = 'underRepair';
    else if (asset.status === 'underRepair') asset.status = 'active';
  }
  asset.updatedBy = req.user.id;
  await asset.save();
  req.auditRecordId = asset._id;
  req.auditBefore = before;
  req.auditAfter = asset.toObject();
  return res.json({ success: true, data: asset });
};

export const transferAsset = async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  if (!requireAssetAuditOutlet(req, res, asset.outlet)) return;
  const toOutlet = req.body.toOutlet;
  if (!isId(toOutlet)) {
    return res.status(422).json({ success: false, message: 'A valid destination outlet is required.' });
  }
  if (!requireAssetAuditOutlet(req, res, toOutlet)) return;
  if (String(toOutlet) === String(asset.outlet)) {
    return res.status(422).json({ success: false, message: 'Choose a different destination outlet.' });
  }
  const destination = await Outlet.findOne({ _id: toOutlet, isActive: true }).lean();
  if (!destination) return res.status(422).json({ success: false, message: 'Destination outlet is invalid or inactive.' });
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(422).json({ success: false, message: 'A transfer reason is required.' });

  const before = asset.toObject();
  const movement = await AssetMovement.create({
    asset: asset._id,
    outlet: asset.outlet,
    type: 'transfer',
    quantityBefore: asset.quantity,
    quantityAfter: asset.quantity,
    conditionBefore: asset.condition,
    conditionAfter: asset.condition,
    locationBefore: asset.location,
    locationAfter: String(req.body.location || ''),
    fromOutlet: asset.outlet,
    toOutlet,
    reason,
    user: req.user.id,
  });
  asset.outlet = toOutlet;
  asset.location = String(req.body.location || '');
  asset.updatedBy = req.user.id;
  await asset.save();
  req.auditRecordId = asset._id;
  req.auditBefore = before;
  req.auditAfter = asset.toObject();
  return res.json({ success: true, data: { asset, movement } });
};

export const deactivateAsset = async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  if (!requireAssetAuditOutlet(req, res, asset.outlet)) return;
  if (['disposed', 'writtenOff'].includes(asset.status)) {
    return res.status(409).json({ success: false, message: 'Posted asset records must be reversed, not deactivated.' });
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(422).json({ success: false, message: 'A reason is required.' });
  const before = asset.toObject();
  asset.status = 'inactive';
  asset.updatedBy = req.user.id;
  await asset.save();
  await AssetMovement.create({
    asset: asset._id,
    outlet: asset.outlet,
    type: 'conditionChange',
    quantityBefore: asset.quantity,
    quantityAfter: asset.quantity,
    conditionBefore: asset.condition,
    conditionAfter: asset.condition,
    locationBefore: asset.location,
    locationAfter: asset.location,
    reason,
    user: req.user.id,
  });
  req.auditRecordId = asset._id;
  req.auditBefore = before;
  req.auditAfter = asset.toObject();
  return res.json({ success: true, data: asset });
};

export const getAssetReconciliation = async (req, res) => {
  const outletId = req.query.outlet;
  if (!isId(outletId)) return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  if (!requireAssetAuditOutlet(req, res, outletId)) return;

  const assets = await Asset.find({
    outlet: outletId,
    status: { $nin: ['disposed', 'writtenOff', 'inactive'] },
  }).lean();
  const accountIds = new Set();
  const register = new Map();
  const add = (accountId, field, amount) => {
    if (!accountId) return;
    const key = String(accountId);
    accountIds.add(key);
    const row = register.get(key) || { grossCost: 0, accumulatedDepreciation: 0 };
    row[field] = round2(row[field] + Number(amount || 0));
    register.set(key, row);
  };
  for (const asset of assets) {
    add(asset.accounts?.asset, 'grossCost', asset.grossCarryingAmount ?? asset.originalCost);
    add(asset.accounts?.accumulatedDepreciation, 'accumulatedDepreciation', asset.accumulatedDepreciation);
  }

  const objectIds = [...accountIds].filter(isId).map((id) => new mongoose.Types.ObjectId(id));
  const [accounts, ledgerRows] = await Promise.all([
    ChartOfAccounts.find({ _id: { $in: objectIds } }).lean(),
    JournalEntry.aggregate([
      { $match: { status: 'posted', outlet: new mongoose.Types.ObjectId(outletId) } },
      { $unwind: '$lines' },
      { $match: { 'lines.account': { $in: objectIds } } },
      {
        $group: {
          _id: '$lines.account',
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ]),
  ]);
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const ledgerById = new Map(ledgerRows.map((row) => [String(row._id), row]));
  const rows = [...accountIds].map((accountId) => {
    const account = accountById.get(accountId);
    const ledger = ledgerById.get(accountId) || { debit: 0, credit: 0 };
    const ledgerBalance = account?.normalBalance === 'credit'
      ? round2(ledger.credit - ledger.debit)
      : round2(ledger.debit - ledger.credit);
    const reg = register.get(accountId);
    const registerBalance = account?.normalBalance === 'credit'
      ? reg.accumulatedDepreciation
      : reg.grossCost;
    return {
      account,
      registerBalance: round2(registerBalance),
      ledgerBalance,
      difference: round2(registerBalance - ledgerBalance),
    };
  }).sort((a, b) => String(a.account?.code || '').localeCompare(String(b.account?.code || '')));

  return res.json({
    success: true,
    data: {
      rows,
      isReconciled: rows.every((row) => Math.abs(row.difference) < 0.01),
    },
  });
};
