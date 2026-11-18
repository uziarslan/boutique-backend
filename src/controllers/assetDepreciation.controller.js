import mongoose from 'mongoose';
import Asset from '../models/Asset.js';
import AssetDepreciationRun from '../models/AssetDepreciationRun.js';
import AssetMovement from '../models/AssetMovement.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { postAssetDepreciation } from '../accounting/assetAccounting.js';
import { requireAssetAuditOutlet } from '../services/assetFeature.service.js';

const isId = (value) => mongoose.isValidObjectId(value);
const round2 = (value) => Number((Number(value) || 0).toFixed(2));
const monthIndex = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

const monthsDue = (asset, throughDate) => {
  const start = asset.lastDepreciationDate
    ? new Date(asset.lastDepreciationDate)
    : new Date(asset.depreciationStartDate || asset.acquisitionDate);
  const diff = monthIndex(throughDate) - monthIndex(start);
  return Math.max(0, diff + (asset.lastDepreciationDate ? 0 : 1));
};

const runAtomic = async (work) => {
  const session = await getTenantConnection().startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (err) {
    const unsupported = /Transaction numbers are only allowed|replica set|does not support transactions/i
      .test(String(err?.message || ''));
    if (!unsupported) throw err;
    return work(null);
  } finally {
    await session.endSession();
  }
};

export const listDepreciationRuns = async (req, res) => {
  const outlet = req.query.outlet;
  if (!isId(outlet)) return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  if (!requireAssetAuditOutlet(req, res, outlet)) return;
  const runs = await AssetDepreciationRun.find({ outlet })
    .populate('createdBy postedBy', 'name email')
    .populate('journalEntry', 'entryNumber date')
    .sort({ throughDate: -1 })
    .lean();
  return res.json({ success: true, data: runs });
};

export const createDepreciationRun = async (req, res) => {
  const outlet = req.body.outlet;
  if (!isId(outlet)) return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  if (!requireAssetAuditOutlet(req, res, outlet)) return;
  const throughDate = req.body.throughDate ? new Date(req.body.throughDate) : new Date();
  if (Number.isNaN(throughDate.getTime())) {
    return res.status(422).json({ success: false, message: 'A valid through date is required.' });
  }
  throughDate.setUTCHours(23, 59, 59, 999);
  const existing = await AssetDepreciationRun.exists({
    outlet,
    throughDate,
    status: { $in: ['draft', 'posted'] },
  });
  if (existing) {
    return res.status(409).json({ success: false, message: 'A depreciation run already exists for this outlet and date.' });
  }
  const assets = await Asset.find({
    outlet,
    status: { $in: ['active', 'underRepair'] },
    depreciationMethod: 'straightLine',
    depreciationStartDate: { $lte: throughDate },
    'accounts.accumulatedDepreciation': { $ne: null },
    'accounts.depreciationExpense': { $ne: null },
  }).lean();

  const lines = [];
  for (const asset of assets) {
    const dueMonths = monthsDue(asset, throughDate);
    if (dueMonths <= 0) continue;
    const originalCost = Number(asset.originalCost) || 0;
    const gross = Number(asset.grossCarryingAmount ?? originalCost) || 0;
    const carryingRatio = originalCost > 0 ? gross / originalCost : 0;
    const residual = Math.min(gross, (Number(asset.residualValue) || 0) * carryingRatio);
    const depreciable = Math.max(0, gross - residual);
    const monthly = asset.usefulLifeMonths > 0
      ? ((originalCost - Number(asset.residualValue || 0)) / asset.usefulLifeMonths) * carryingRatio
      : 0;
    const remaining = Math.max(0, depreciable - Number(asset.accumulatedDepreciation || 0));
    const amount = round2(Math.min(remaining, monthly * dueMonths));
    if (amount <= 0) continue;
    lines.push({
      asset: asset._id,
      openingAccumulatedDepreciation: round2(asset.accumulatedDepreciation),
      amount,
      closingAccumulatedDepreciation: round2(asset.accumulatedDepreciation + amount),
      assetAccount: asset.accounts?.asset,
      accumulatedDepreciationAccount: asset.accounts?.accumulatedDepreciation,
      depreciationExpenseAccount: asset.accounts?.depreciationExpense,
    });
  }
  if (lines.length === 0) {
    return res.status(422).json({
      success: false,
      message: 'No depreciation is due. Check category account mappings and depreciation dates.',
    });
  }
  const run = await AssetDepreciationRun.create({
    outlet,
    throughDate,
    lines,
    totalAmount: round2(lines.reduce((sum, line) => sum + line.amount, 0)),
    notes: String(req.body.notes || ''),
    createdBy: req.user.id,
  });
  return res.status(201).json({ success: true, data: run });
};

export const getDepreciationRun = async (req, res) => {
  const run = await AssetDepreciationRun.findById(req.params.id)
    .populate('outlet', 'name code')
    .populate('lines.asset', 'assetNumber name grossCarryingAmount accumulatedDepreciation')
    .populate('journalEntry', 'entryNumber date')
    .lean();
  if (!run) return res.status(404).json({ success: false, message: 'Depreciation run not found.' });
  if (!requireAssetAuditOutlet(req, res, run.outlet?._id || run.outlet)) return;
  return res.json({ success: true, data: run });
};

export const postDepreciationRun = async (req, res) => {
  const existing = await AssetDepreciationRun.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Depreciation run not found.' });
  if (!requireAssetAuditOutlet(req, res, existing.outlet)) return;
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, message: 'This depreciation run has already been posted.' });
  }

  const result = await runAtomic(async (session) => {
    const runQuery = AssetDepreciationRun.findById(existing._id);
    if (session) runQuery.session(session);
    const run = await runQuery;
    if (run.status !== 'draft') {
      const err = new Error('This depreciation run has already been posted.');
      err.statusCode = 409;
      throw err;
    }
    const entry = await postAssetDepreciation({ run, userId: req.user.id, session });
    const movements = [];
    for (const line of run.lines) {
      const query = Asset.findById(line.asset);
      if (session) query.session(session);
      const asset = await query;
      if (!asset) {
        const err = new Error('An asset in this run no longer exists.');
        err.statusCode = 409;
        throw err;
      }
      if (Math.abs(Number(asset.accumulatedDepreciation) - Number(line.openingAccumulatedDepreciation)) > 0.01) {
        const err = new Error(`${asset.assetNumber} changed after this run was prepared. Create a fresh run.`);
        err.statusCode = 409;
        throw err;
      }
      asset.accumulatedDepreciation = line.closingAccumulatedDepreciation;
      asset.lastDepreciationDate = run.throughDate;
      asset.updatedBy = req.user.id;
      await asset.save({ session: session || undefined });
      movements.push({
        asset: asset._id,
        outlet: asset.outlet,
        type: 'depreciation',
        quantityBefore: asset.quantity,
        quantityAfter: asset.quantity,
        conditionBefore: asset.condition,
        conditionAfter: asset.condition,
        locationBefore: asset.location,
        locationAfter: asset.location,
        depreciationRun: run._id,
        journalEntry: entry?._id || null,
        amount: line.amount,
        reason: `Depreciation through ${run.throughDate.toISOString().slice(0, 10)}`,
        user: req.user.id,
      });
    }
    if (movements.length) {
      await AssetMovement.insertMany(movements, session ? { session } : undefined);
    }
    run.status = 'posted';
    run.journalEntry = entry?._id || null;
    run.postedBy = req.user.id;
    run.postedAt = new Date();
    await run.save({ session: session || undefined });
    return { run, journalEntry: entry };
  });
  return res.json({ success: true, data: result });
};
