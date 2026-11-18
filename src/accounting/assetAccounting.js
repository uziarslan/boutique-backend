import JournalEntry from '../models/JournalEntry.js';
import logger from '../utils/logger.js';

const round2 = (value) => Number((Number(value) || 0).toFixed(2));

export const postAssetWriteOff = async ({
  asset,
  audit,
  quantityRemoved,
  userId,
  reason,
  session,
}) => {
  const quantityBefore = Math.max(0, Number(asset.quantity) || 0);
  const removeQty = Math.min(quantityBefore, Math.max(0, Number(quantityRemoved) || 0));
  if (removeQty <= 0) return null;

  const grossBefore = Number(asset.grossCarryingAmount ?? asset.originalCost) || 0;
  const ratio = quantityBefore > 0 ? removeQty / quantityBefore : 0;
  const costRemoved = round2(grossBefore * ratio);
  const depRemoved = round2(Math.min(
    Number(asset.accumulatedDepreciation) || 0,
    (Number(asset.accumulatedDepreciation) || 0) * ratio,
  ));
  const loss = round2(Math.max(0, costRemoved - depRemoved));
  if (costRemoved <= 0) {
    return {
      entry: null,
      costRemoved: 0,
      depRemoved: 0,
      loss: 0,
    };
  }

  const accounts = asset.accounts || {};
  if (!accounts.asset || !accounts.lossOnDisposal) {
    const err = new Error(
      `Asset ${asset.assetNumber} needs Asset and Loss/Write-off COA mappings before it can be written off.`,
    );
    err.statusCode = 422;
    throw err;
  }
  if (depRemoved > 0 && !accounts.accumulatedDepreciation) {
    const err = new Error(
      `Asset ${asset.assetNumber} needs an Accumulated Depreciation account before it can be written off.`,
    );
    err.statusCode = 422;
    throw err;
  }

  const lines = [];
  if (depRemoved > 0) {
    lines.push({
      account: accounts.accumulatedDepreciation,
      debit: depRemoved,
      credit: 0,
      notes: `Remove accumulated depreciation — ${asset.assetNumber}`,
    });
  }
  if (loss > 0) {
    lines.push({
      account: accounts.lossOnDisposal,
      debit: loss,
      credit: 0,
      notes: `Asset audit write-off — ${asset.assetNumber}`,
    });
  }
  lines.push({
    account: accounts.asset,
    debit: 0,
    credit: costRemoved,
    notes: `Remove asset cost — ${asset.assetNumber}`,
  });

  const [entry] = await JournalEntry.create([{
    date: audit.approvedAt || new Date(),
    description: `Asset audit write-off — ${asset.assetNumber}`,
    itemSummary: asset.name,
    sourceNumber: audit.auditNumber,
    sourcePath: `/assets/audits/${audit._id}`,
    lines,
    sourceModule: 'assetAuditAdjustment',
    sourceId: audit._id,
    outlet: asset.outlet,
    status: 'posted',
    createdBy: userId,
  }], session ? { session } : undefined);

  logger.info(
    `JE posted [asset write-off]: ${entry.entryNumber} | asset=${asset.assetNumber} ` +
    `cost=${costRemoved} dep=${depRemoved} loss=${loss}`,
  );
  return { entry, costRemoved, depRemoved, loss };
};

export const postAssetDepreciation = async ({ run, userId, session }) => {
  const grouped = new Map();
  for (const line of run.lines || []) {
    const amount = round2(line.amount);
    if (amount <= 0) continue;
    const key = `${line.depreciationExpenseAccount}:${line.accumulatedDepreciationAccount}`;
    const current = grouped.get(key) || {
      expense: line.depreciationExpenseAccount,
      accumulated: line.accumulatedDepreciationAccount,
      amount: 0,
    };
    current.amount = round2(current.amount + amount);
    grouped.set(key, current);
  }
  if (grouped.size === 0) return null;

  const lines = [];
  for (const group of grouped.values()) {
    lines.push({
      account: group.expense,
      debit: group.amount,
      credit: 0,
      notes: `Depreciation ${run.runNumber}`,
    });
    lines.push({
      account: group.accumulated,
      debit: 0,
      credit: group.amount,
      notes: `Accumulated depreciation ${run.runNumber}`,
    });
  }

  const [entry] = await JournalEntry.create([{
    date: run.throughDate,
    description: `Asset depreciation — ${run.runNumber}`,
    sourceNumber: run.runNumber,
    sourcePath: '/assets/accounting',
    lines,
    sourceModule: 'assetDepreciation',
    sourceId: run._id,
    outlet: run.outlet,
    status: 'posted',
    createdBy: userId,
  }], session ? { session } : undefined);
  return entry;
};
