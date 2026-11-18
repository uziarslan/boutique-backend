import mongoose from 'mongoose';
import Asset from '../models/Asset.js';
import AssetAudit from '../models/AssetAudit.js';
import AssetAuditLine from '../models/AssetAuditLine.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetMovement from '../models/AssetMovement.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { postAssetWriteOff } from '../accounting/assetAccounting.js';
import {
  enabledAssetAuditOutletIds,
  requireAssetAuditOutlet,
} from '../services/assetFeature.service.js';

const isId = (value) => mongoose.isValidObjectId(value);
const round2 = (value) => Number((Number(value) || 0).toFixed(2));

const populatedAudit = (query) => query
  .populate('outlet', 'name code timezone')
  .populate('scope.category', 'name code')
  .populate('assignedTo', 'name email')
  .populate('createdBy startedBy submittedBy reviewedBy approvedBy', 'name email');

const auditScopeFilter = (audit) => {
  const filter = {
    outlet: audit.outlet?._id || audit.outlet,
    status: { $in: ['active', 'underRepair', 'missing'] },
  };
  if (audit.scope?.type === 'category' && audit.scope.category) {
    filter.category = audit.scope.category?._id || audit.scope.category;
  } else if (audit.scope?.type === 'location' && audit.scope.location) {
    filter.location = audit.scope.location;
  } else if (audit.scope?.type === 'selected') {
    filter._id = { $in: audit.scope.assetIds || [] };
  }
  return filter;
};

const refreshAuditTotals = async (auditId, session = null) => {
  const aggregate = AssetAuditLine.aggregate([
    { $match: { audit: new mongoose.Types.ObjectId(auditId) } },
    {
      $group: {
        _id: null,
        totalAssets: { $sum: 1 },
        countedAssets: { $sum: { $cond: [{ $ne: ['$countedQuantity', null] }, 1, 0] } },
        varianceLines: { $sum: { $cond: [{ $ne: ['$variance', 0] }, 1, 0] } },
        estimatedVarianceValue: {
          $sum: { $multiply: [{ $abs: '$variance' }, '$originalUnitCostSnapshot'] },
        },
      },
    },
  ]);
  if (session) aggregate.session(session);
  const rows = await aggregate;
  const totals = rows[0] || {
    totalAssets: 0,
    countedAssets: 0,
    varianceLines: 0,
    estimatedVarianceValue: 0,
  };
  totals.estimatedVarianceValue = round2(totals.estimatedVarianceValue);
  await AssetAudit.updateOne(
    { _id: auditId },
    { $set: totals },
    session ? { session } : undefined,
  );
  return totals;
};

const runAtomic = async (work) => {
  const session = await getTenantConnection().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
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

export const listAssetAudits = async (req, res) => {
  const enabledIds = enabledAssetAuditOutletIds(req.tenant).filter(isId);
  const filter = { outlet: { $in: enabledIds } };
  if (req.query.outlet) {
    if (!isId(req.query.outlet)) {
      return res.status(422).json({ success: false, message: 'Invalid outlet.' });
    }
    if (!requireAssetAuditOutlet(req, res, req.query.outlet)) return;
    filter.outlet = req.query.outlet;
  }
  if (req.query.status) filter.status = req.query.status;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const [audits, total] = await Promise.all([
    populatedAudit(
      AssetAudit.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ).lean(),
    AssetAudit.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data: { audits, total, page, pages: Math.ceil(total / limit) },
  });
};

export const createAssetAudit = async (req, res) => {
  const outlet = req.body.outlet;
  if (!isId(outlet)) return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  if (!requireAssetAuditOutlet(req, res, outlet)) return;
  const scopeType = ['all', 'category', 'location', 'selected'].includes(req.body.scope?.type)
    ? req.body.scope.type
    : 'all';
  if (scopeType === 'category' && !isId(req.body.scope?.category)) {
    return res.status(422).json({ success: false, message: 'Choose a category for this audit.' });
  }
  if (scopeType === 'location' && !String(req.body.scope?.location || '').trim()) {
    return res.status(422).json({ success: false, message: 'Enter a location for this audit.' });
  }
  const assetIds = scopeType === 'selected'
    ? (req.body.scope?.assetIds || []).filter(isId)
    : [];
  if (scopeType === 'selected' && assetIds.length === 0) {
    return res.status(422).json({ success: false, message: 'Select at least one asset.' });
  }
  const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
  const audit = await AssetAudit.create({
    title: String(req.body.title || '').trim(),
    outlet,
    scope: {
      type: scopeType,
      category: scopeType === 'category' ? req.body.scope.category : null,
      location: scopeType === 'location' ? String(req.body.scope.location).trim() : '',
      assetIds,
    },
    blindCount: req.body.blindCount !== false,
    scheduledFor,
    status: scheduledFor && scheduledFor > new Date() ? 'scheduled' : 'draft',
    assignedTo: (req.body.assignedTo || []).filter(isId),
    notes: String(req.body.notes || '').trim(),
    createdBy: req.user.id,
  });
  req.auditRecordId = audit._id;
  req.auditAfter = audit.toObject();
  return res.status(201).json({ success: true, data: audit });
};

export const getAssetAudit = async (req, res) => {
  const audit = await populatedAudit(AssetAudit.findById(req.params.id)).lean();
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet?._id || audit.outlet)) return;
  let lines = await AssetAuditLine.find({ audit: audit._id })
    .populate('asset', 'assetNumber name quantity condition location status accountingLinked')
    .populate('countedBy reviewedBy', 'name email')
    .sort({ nameSnapshot: 1 })
    .lean();

  const mayReview = req.user.hasPermission('assetAudits.review')
    || req.user.hasPermission('assetAudits.approve');
  if (audit.blindCount && !mayReview && ['inProgress', 'recountRequested'].includes(audit.status)) {
    lines = lines.map((line) => ({
      ...line,
      expectedQuantity: undefined,
      expectedLocation: undefined,
      expectedCondition: undefined,
      originalUnitCostSnapshot: undefined,
      originalCostSnapshot: undefined,
      accumulatedDepreciationSnapshot: undefined,
      variance: undefined,
    }));
  }
  return res.json({ success: true, data: { ...audit, lines } });
};

export const startAssetAudit = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (!['draft', 'scheduled', 'recountRequested'].includes(audit.status)) {
    return res.status(409).json({ success: false, message: 'This audit cannot be started in its current state.' });
  }

  if (audit.status === 'recountRequested') {
    await AssetAuditLine.updateMany(
      { audit: audit._id, status: 'recountRequired' },
      {
        $set: {
          countedQuantity: null,
          approvedQuantity: null,
          variance: 0,
          countedCondition: '',
          foundLocation: '',
          status: 'pending',
          reviewAction: 'pending',
          countedBy: null,
          countedAt: null,
          reviewerNotes: '',
          reviewedBy: null,
          reviewedAt: null,
        },
      },
    );
  } else {
    const existingLines = await AssetAuditLine.countDocuments({ audit: audit._id });
    if (existingLines > 0) {
      return res.status(409).json({ success: false, message: 'This audit already has a snapshot.' });
    }
    const assets = await Asset.find(auditScopeFilter(audit)).sort({ name: 1 }).lean();
    if (assets.length === 0) {
      return res.status(422).json({ success: false, message: 'No active assets match this audit scope.' });
    }
    await AssetAuditLine.insertMany(assets.map((asset) => ({
      audit: audit._id,
      asset: asset._id,
      assetNumberSnapshot: asset.assetNumber,
      nameSnapshot: asset.name,
      trackingMode: asset.trackingMode,
      expectedQuantity: asset.quantity,
      expectedLocation: asset.location,
      expectedCondition: asset.condition,
      originalUnitCostSnapshot: asset.originalUnitCost,
      originalCostSnapshot: asset.grossCarryingAmount ?? asset.originalCost,
      accumulatedDepreciationSnapshot: asset.accumulatedDepreciation,
    })));
    audit.snapshotAt = new Date();
  }
  audit.status = 'inProgress';
  audit.startedAt = audit.startedAt || new Date();
  audit.startedBy = audit.startedBy || req.user.id;
  await audit.save();
  await refreshAuditTotals(audit._id);
  req.auditRecordId = audit._id;
  req.auditAfter = audit.toObject();
  return res.json({ success: true, data: audit });
};

export const countAssetAuditLine = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (audit.status !== 'inProgress') {
    return res.status(409).json({ success: false, message: 'This audit is not open for counting.' });
  }
  const countedQuantity = Number(req.body.countedQuantity);
  if (!Number.isFinite(countedQuantity) || countedQuantity < 0) {
    return res.status(422).json({ success: false, message: 'Counted quantity must be zero or greater.' });
  }
  const line = await AssetAuditLine.findOne({ _id: req.params.lineId, audit: audit._id });
  if (!line) return res.status(404).json({ success: false, message: 'Audit line not found.' });
  if (line.trackingMode === 'serialized' && countedQuantity > 1) {
    return res.status(422).json({ success: false, message: 'A serialized asset count can only be zero or one.' });
  }
  line.countedQuantity = countedQuantity;
  line.variance = round2(countedQuantity - line.expectedQuantity);
  line.countedCondition = req.body.countedCondition || (countedQuantity === 0 ? 'missing' : line.expectedCondition || 'good');
  line.foundLocation = String(req.body.foundLocation ?? line.expectedLocation ?? '').trim();
  line.evidenceUrls = Array.isArray(req.body.evidenceUrls) ? req.body.evidenceUrls : line.evidenceUrls;
  line.notes = String(req.body.notes || '').trim();
  line.status = 'counted';
  line.countedBy = req.user.id;
  line.countedAt = new Date();
  await line.save();
  await refreshAuditTotals(audit._id);
  return res.json({ success: true, data: line });
};

export const addUnregisteredAuditLine = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (audit.status !== 'inProgress') {
    return res.status(409).json({ success: false, message: 'This audit is not open for counting.' });
  }
  const name = String(req.body.name || '').trim();
  const quantity = Number(req.body.countedQuantity);
  if (!name || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(422).json({ success: false, message: 'Name and a positive quantity are required.' });
  }
  const trackingMode = req.body.trackingMode === 'bulk' ? 'bulk' : 'serialized';
  if (trackingMode === 'serialized' && (!Number.isInteger(quantity) || quantity !== 1)) {
    return res.status(422).json({
      success: false,
      message: 'Add each unregistered serialized asset as a separate finding.',
    });
  }
  const line = await AssetAuditLine.create({
    audit: audit._id,
    asset: null,
    unregisteredName: name,
    nameSnapshot: name,
    trackingMode,
    expectedQuantity: 0,
    countedQuantity: quantity,
    variance: quantity,
    countedCondition: req.body.countedCondition || 'good',
    foundLocation: String(req.body.foundLocation || ''),
    reviewAction: 'investigate',
    status: 'counted',
    evidenceUrls: Array.isArray(req.body.evidenceUrls) ? req.body.evidenceUrls : [],
    notes: String(req.body.notes || ''),
    countedBy: req.user.id,
    countedAt: new Date(),
  });
  await refreshAuditTotals(audit._id);
  return res.status(201).json({ success: true, data: line });
};

export const submitAssetAudit = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (audit.status !== 'inProgress') {
    return res.status(409).json({ success: false, message: 'This audit is not open for submission.' });
  }
  const pending = await AssetAuditLine.find({ audit: audit._id, countedQuantity: null });
  if (pending.length > 0 && req.body.markUncountedMissing !== true) {
    return res.status(422).json({
      success: false,
      message: `${pending.length} asset(s) have not been counted. Count them or confirm they are missing.`,
      pendingCount: pending.length,
    });
  }
  if (pending.length > 0) {
    await AssetAuditLine.updateMany(
      { audit: audit._id, countedQuantity: null },
      [{
        $set: {
          countedQuantity: 0,
          variance: { $multiply: ['$expectedQuantity', -1] },
          countedCondition: 'missing',
          status: 'counted',
          countedBy: new mongoose.Types.ObjectId(req.user.id),
          countedAt: new Date(),
          notes: 'Not found during audit',
        },
      }],
    );
  }
  audit.status = 'submitted';
  audit.submittedAt = new Date();
  audit.submittedBy = req.user.id;
  await audit.save();
  const totals = await refreshAuditTotals(audit._id);
  req.auditRecordId = audit._id;
  req.auditAfter = { ...audit.toObject(), ...totals };
  return res.json({ success: true, data: { audit, totals } });
};

export const reviewAssetAudit = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (!['submitted', 'underReview'].includes(audit.status)) {
    return res.status(409).json({ success: false, message: 'This audit is not ready for review.' });
  }
  const updates = Array.isArray(req.body.lines) ? req.body.lines : [];
  for (const update of updates) {
    if (!isId(update.lineId)) continue;
    const set = {
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    };
    if ([
      'noChange',
      'quantityAdjustment',
      'conditionUpdate',
      'writeOff',
      'recount',
      'investigate',
      'registerAsset',
    ].includes(update.reviewAction)) set.reviewAction = update.reviewAction;
    const currentLine = await AssetAuditLine.findOne({
      _id: update.lineId,
      audit: audit._id,
    }).select('asset');
    if (currentLine && !currentLine.asset) set.reviewAction = 'investigate';
    if (Number.isFinite(Number(update.approvedQuantity)) && Number(update.approvedQuantity) >= 0) {
      set.approvedQuantity = Number(update.approvedQuantity);
    }
    if (update.reviewerNotes !== undefined) set.reviewerNotes = String(update.reviewerNotes || '');
    set.status = update.reviewAction === 'recount' ? 'recountRequired' : 'resolved';
    await AssetAuditLine.updateOne({ _id: update.lineId, audit: audit._id }, { $set: set });
  }
  audit.status = 'underReview';
  audit.reviewedAt = new Date();
  audit.reviewedBy = req.user.id;
  await audit.save();
  return res.json({ success: true, data: audit });
};

export const requestAssetAuditRecount = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (!['submitted', 'underReview'].includes(audit.status)) {
    return res.status(409).json({ success: false, message: 'This audit cannot be sent for recount.' });
  }
  const lineIds = (req.body.lineIds || []).filter(isId);
  const filter = { audit: audit._id };
  if (lineIds.length) filter._id = { $in: lineIds };
  await AssetAuditLine.updateMany(filter, {
    $set: {
      status: 'recountRequired',
      reviewAction: 'recount',
      reviewerNotes: String(req.body.reason || 'Recount requested'),
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    },
  });
  audit.status = 'recountRequested';
  audit.reviewedAt = new Date();
  audit.reviewedBy = req.user.id;
  await audit.save();
  return res.json({ success: true, data: audit });
};

export const approveAssetAudit = async (req, res) => {
  const existing = await AssetAudit.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, existing.outlet)) return;
  if (!['submitted', 'underReview'].includes(existing.status)) {
    return res.status(409).json({ success: false, message: 'This audit is not ready for approval.' });
  }
  const postAccounting = req.body.postAccounting === true;
  if (postAccounting && !req.user.hasPermission('assets.accounting')) {
    return res.status(403).json({ success: false, message: 'Asset accounting permission is required to post write-offs.' });
  }
  const selfCounted = await AssetAuditLine.exists({ audit: existing._id, countedBy: req.user.id });
  const overrideReason = String(req.body.ownerOverrideReason || '').trim();
  if (selfCounted && !(req.user.role === 'owner' && overrideReason.length >= 5)) {
    return res.status(409).json({
      success: false,
      message: 'A person who counted this audit cannot approve it. Owner override requires a recorded reason.',
    });
  }

  const result = await runAtomic(async (session) => {
    const auditQuery = AssetAudit.findById(existing._id);
    if (session) auditQuery.session(session);
    const audit = await auditQuery;
    if (!['submitted', 'underReview'].includes(audit.status)) {
      const err = new Error('This audit has already been approved or changed.');
      err.statusCode = 409;
      throw err;
    }
    const lineQuery = AssetAuditLine.find({ audit: audit._id });
    if (session) lineQuery.session(session);
    const lines = await lineQuery;
    const unresolvedRecounts = lines.filter(
      (line) => line.status === 'recountRequired' || line.reviewAction === 'recount',
    );
    if (unresolvedRecounts.length > 0) {
      const err = new Error('Complete the requested recounts before approval.');
      err.statusCode = 409;
      throw err;
    }

    const journalEntries = [];
    const movements = [];
    const now = new Date();
    for (const line of lines) {
      if (!line.asset) {
        line.reviewAction = 'investigate';
        line.status = 'resolved';
        line.reviewedBy = line.reviewedBy || req.user.id;
        line.reviewedAt = line.reviewedAt || now;
        await line.save({ session: session || undefined });
        continue;
      }
      const assetQuery = Asset.findById(line.asset).populate('category');
      if (session) assetQuery.session(session);
      const asset = await assetQuery;
      if (!asset) continue;

      const expectedAtSnapshot = Number(line.expectedQuantity) || 0;
      const currentQty = Number(asset.quantity) || 0;
      if (
        currentQty !== expectedAtSnapshot
        && req.body.forceConcurrentAdjustment !== true
      ) {
        const err = new Error(
          `${asset.assetNumber} changed after the audit snapshot. Review its movement history and recount it.`,
        );
        err.statusCode = 409;
        throw err;
      }

      const requestedQty = line.approvedQuantity == null
        ? Number(line.countedQuantity)
        : Number(line.approvedQuantity);
      const requestedSafeQty = asset.trackingMode === 'serialized'
        ? Math.min(1, Math.max(0, requestedQty || 0))
        : Math.max(0, requestedQty || 0);
      const inferredAction = requestedSafeQty === currentQty
        ? (
          (line.countedCondition && line.countedCondition !== asset.condition)
          || (line.foundLocation && line.foundLocation !== asset.location)
            ? 'conditionUpdate'
            : 'noChange'
        )
        : 'quantityAdjustment';
      const reviewAction = line.reviewAction === 'pending'
        ? inferredAction
        : line.reviewAction;
      if (reviewAction === 'investigate') {
        line.status = 'resolved';
        line.reviewedBy = line.reviewedBy || req.user.id;
        line.reviewedAt = line.reviewedAt || now;
        await line.save({ session: session || undefined });
        continue;
      }
      const safeQty = ['noChange', 'conditionUpdate'].includes(reviewAction)
        ? currentQty
        : requestedSafeQty;
      const delta = round2(safeQty - currentQty);
      if (asset.accountingLinked && delta > 0) {
        const err = new Error(
          `${asset.assetNumber} is accounting-linked and cannot be increased from an audit. Record the surplus as an unregistered asset and investigate its acquisition.`,
        );
        err.statusCode = 422;
        throw err;
      }
      if (asset.accountingLinked && delta < 0 && reviewAction !== 'writeOff') {
        const err = new Error(
          `${asset.assetNumber} is accounting-linked. Choose Write off shortage so its register value and ledger are reduced together.`,
        );
        err.statusCode = 422;
        throw err;
      }
      const conditionAfter = reviewAction === 'noChange'
        ? asset.condition
        : (line.countedCondition || asset.condition);
      const locationAfter = reviewAction === 'noChange'
        ? asset.location
        : (line.foundLocation || asset.location);
      let journalResult = null;

      if (reviewAction === 'writeOff') {
        if (!postAccounting) {
          const err = new Error('Write-off lines require accounting posting to be enabled.');
          err.statusCode = 422;
          throw err;
        }
        if (delta >= 0) {
          const err = new Error(`Write-off quantity for ${asset.assetNumber} must be lower than the register quantity.`);
          err.statusCode = 422;
          throw err;
        }
        audit.approvedAt = now;
        journalResult = await postAssetWriteOff({
          asset,
          audit,
          quantityRemoved: Math.abs(delta),
          userId: req.user.id,
          reason: line.reviewerNotes || line.notes,
          session,
        });
        if (journalResult?.entry) journalEntries.push(journalResult.entry._id);
        asset.grossCarryingAmount = round2(
          Number(asset.grossCarryingAmount ?? asset.originalCost) - journalResult.costRemoved,
        );
        asset.accumulatedDepreciation = round2(
          Number(asset.accumulatedDepreciation || 0) - journalResult.depRemoved,
        );
      } else if (delta !== 0 && !asset.accountingLinked) {
        const grossBefore = Number(asset.grossCarryingAmount ?? asset.originalCost) || 0;
        const valueChange = delta < 0 && currentQty > 0
          ? (grossBefore / currentQty) * delta
          : Number(asset.originalUnitCost || 0) * delta;
        if (delta < 0 && grossBefore > 0) {
          const removedRatio = Math.min(1, Math.abs(valueChange) / grossBefore);
          asset.accumulatedDepreciation = round2(
            Number(asset.accumulatedDepreciation || 0) * (1 - removedRatio),
          );
        }
        asset.grossCarryingAmount = round2(Math.max(0, grossBefore + valueChange));
      }

      if (delta !== 0 || conditionAfter !== asset.condition || locationAfter !== asset.location) {
        movements.push({
          asset: asset._id,
          outlet: asset.outlet,
          type: reviewAction === 'writeOff' ? 'writeOff' : 'auditAdjustment',
          quantityBefore: currentQty,
          quantityChange: delta,
          quantityAfter: safeQty,
          conditionBefore: asset.condition,
          conditionAfter,
          locationBefore: asset.location,
          locationAfter,
          audit: audit._id,
          journalEntry: journalResult?.entry?._id || null,
          amount: journalResult?.costRemoved || round2(Math.abs(delta) * asset.originalUnitCost),
          reason: line.reviewerNotes || line.notes || `Approved from ${audit.auditNumber}`,
          user: req.user.id,
          at: now,
        });
      }

      asset.quantity = safeQty;
      asset.condition = conditionAfter;
      asset.location = locationAfter;
      asset.lastAuditAt = now;
      const frequencyDays = Number(asset.category?.auditFrequencyDays) || 90;
      asset.nextAuditDueAt = new Date(now.getTime() + frequencyDays * 86400000);
      if (reviewAction === 'writeOff') {
        asset.status = safeQty === 0 ? 'writtenOff' : asset.status;
      } else if (safeQty === 0 || conditionAfter === 'missing') {
        asset.status = 'missing';
      } else if (conditionAfter === 'underRepair') {
        asset.status = 'underRepair';
      } else if (['missing', 'underRepair'].includes(asset.status)) {
        asset.status = 'active';
      }
      asset.updatedBy = req.user.id;
      await asset.save({ session: session || undefined });
      line.approvedQuantity = safeQty;
      line.reviewAction = reviewAction;
      line.status = 'resolved';
      line.reviewedBy = line.reviewedBy || req.user.id;
      line.reviewedAt = line.reviewedAt || now;
      await line.save({ session: session || undefined });
    }

    if (movements.length > 0) {
      await AssetMovement.insertMany(movements, session ? { session } : undefined);
    }
    audit.status = 'approved';
    audit.approvedAt = now;
    audit.approvedBy = req.user.id;
    audit.ownerOverrideReason = overrideReason;
    audit.journalEntries = journalEntries;
    await audit.save({ session: session || undefined });
    return { audit, movements: movements.length, journalEntries };
  });

  req.auditRecordId = result.audit._id;
  req.auditAfter = result.audit.toObject();
  return res.json({ success: true, data: result });
};

export const rejectAssetAudit = async (req, res) => {
  const audit = await AssetAudit.findById(req.params.id);
  if (!audit) return res.status(404).json({ success: false, message: 'Asset audit not found.' });
  if (!requireAssetAuditOutlet(req, res, audit.outlet)) return;
  if (!['submitted', 'underReview'].includes(audit.status)) {
    return res.status(409).json({ success: false, message: 'This audit cannot be rejected.' });
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) return res.status(422).json({ success: false, message: 'A rejection reason is required.' });
  audit.status = 'rejected';
  audit.reviewedAt = new Date();
  audit.reviewedBy = req.user.id;
  audit.notes = `${audit.notes ? `${audit.notes}\n` : ''}Rejected: ${reason}`;
  await audit.save();
  return res.json({ success: true, data: audit });
};
