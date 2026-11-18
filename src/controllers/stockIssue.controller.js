import mongoose from 'mongoose';
import StockItem from '../models/StockItem.js';
import StockIssue from '../models/StockIssue.js';
import Product from '../models/Product.js';
import generateIssueNumber from '../utils/issueNumber.js';
import { recordStockMovements } from '../services/stockLedger.js';
import { dropLegacyStockIndexIfPresent } from '../utils/stockIndexes.js';
import { convertQty } from '../utils/unitConversion.js';
import { getIo } from '../utils/socket.js';
import logger from '../utils/logger.js';

// Notify everyone watching this tenant's "ops" room that a transfer changed
// state (created / accepted / rejected) so their badges + lists update live.
const emitTransferChanged = (tenantSlug, payload) => {
  try {
    const io = getIo();
    if (io && tenantSlug) io.to(`ops:${tenantSlug}`).emit('transfer:changed', payload);
  } catch (err) {
    logger.warn(`[transfer socket] emit skipped: ${err.message}`);
  }
};

const round4 = (n) => parseFloat((Number(n) || 0).toFixed(4));
const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

// Resolve the areas / ledger types / receiver permission for a transfer direction.
const dirMeta = (direction) => {
  const kToS = direction === 'kitchenToStore';
  return {
    direction: kToS ? 'kitchenToStore' : 'storeToKitchen',
    sourceArea: kToS ? 'kitchen' : 'store',
    destArea:   kToS ? 'store'   : 'kitchen',
    outType:    kToS ? 'return-out' : 'issue-out',
    inType:     kToS ? 'return-in'  : 'issue-in',
    numberPrefix: kToS ? 'RET' : 'ISS',
    // Who may ISSUE (sender side) and who may ACCEPT/REJECT (receiver side).
    senderPerm:   kToS ? 'inventory.manage' : 'store.manage',
    receiverPerm: kToS ? 'store.manage'     : 'inventory.manage',
  };
};

// Credit an area's on-hand for a product, creating the row if absent. Hardened
// against the concurrent-upsert race AND a lingering legacy { product, outlet }
// unique index (self-heals by dropping it, then retries).
const creditStockUpsert = async ({ product, outlet, area, qty, unit }) => {
  const filter = { product, outlet, area };
  const update = {
    $inc: { qtyOnHand: qty },
    $set: { updatedAt: new Date() },
    $setOnInsert: { product, outlet, area, unit },
  };
  try {
    return await StockItem.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
  } catch (err) {
    if (err && err.code === 11000) {
      const healed = await dropLegacyStockIndexIfPresent();
      if (healed) return await StockItem.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
      const updated = await StockItem.findOneAndUpdate(
        filter,
        { $inc: { qtyOnHand: qty }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw err;
      return updated;
    }
    throw err;
  }
};

// ─── createIssue ────────────────────────────────────────────────────────────
// POST /api/stock-issues
// Body: { outlet, direction?, lines: [{ product, qty, unit? }], notes? }
// ISSUES a transfer between the store and kitchen within one outlet:
//   direction 'storeToKitchen' (default) — store → kitchen
//   direction 'kitchenToStore'           — kitchen → store
// The SOURCE is debited immediately and the transfer sits 'in_transit' until the
// receiving area accepts (credits the dest) or rejects (returns to source).
// Blocks if the SOURCE area lacks enough of any line. No journal entry.
export const createIssue = async (req, res) => {
  const { outlet: rawOutlet, lines, notes } = req.body;
  const { direction, sourceArea, outType, numberPrefix, senderPerm } = dirMeta(req.body.direction);

  // Only the SENDING area's manager may issue in that direction.
  if (!req.user.hasPermission(senderPerm)) {
    return res.status(403).json({
      success: false,
      message: `You need ${sourceArea} permissions to send a ${sourceArea}→${direction === 'kitchenToStore' ? 'store' : 'kitchen'} transfer.`,
    });
  }

  if (!rawOutlet || !mongoose.isValidObjectId(rawOutlet)) {
    return res.status(400).json({ success: false, message: 'Valid outlet ID is required.' });
  }
  const outlet = new mongoose.Types.ObjectId(rawOutlet);

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(422).json({ success: false, message: 'At least one line is required.' });
  }

  // Normalise + validate line shape (capture the entry unit).
  const clean = [];
  for (const l of lines) {
    if (!l || !mongoose.isValidObjectId(l.product)) {
      return res.status(422).json({ success: false, message: `Invalid product ID on a line: ${l?.product}` });
    }
    const qty = round4(l.qty);
    if (!(qty > 0)) {
      return res.status(422).json({ success: false, message: 'Each line must have a quantity greater than zero.' });
    }
    clean.push({ product: new mongoose.Types.ObjectId(l.product), qty, unit: l.unit, notes: l.notes });
  }

  const productIds0 = [...new Set(clean.map((l) => l.product.toString()))].map((id) => new mongoose.Types.ObjectId(id));

  // Load SOURCE balances + product costs/units (needed for base-unit conversion).
  const [sourceStock, products] = await Promise.all([
    StockItem.find({ product: { $in: productIds0 }, outlet, area: sourceArea }).lean(),
    Product.find({ _id: { $in: productIds0 } }).select('name unit currentPrice').lean(),
  ]);
  const sourceByProduct = Object.fromEntries(sourceStock.map((s) => [s.product.toString(), s]));
  const productByProduct = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

  // Convert each line's entered quantity into the product's base stock unit
  // (e.g. 500 g against a kg-based item → 0.5 kg). Stock is held in base units,
  // so validation and movement all happen in base units.
  const convertedLines = [];
  for (const l of clean) {
    const key = l.product.toString();
    const baseUnit = sourceByProduct[key]?.unit || productByProduct[key]?.unit || '';
    const enteredUnit = (l.unit && String(l.unit).trim()) || baseUnit;
    const { qty: baseQty, converted } = convertQty(l.qty, enteredUnit, baseUnit);
    if (!converted) {
      return res.status(422).json({
        success: false,
        message: `Cannot convert ${enteredUnit || 'the entered unit'} to ${baseUnit || 'the base unit'} for "${productByProduct[key]?.name ?? key}". Use a compatible unit.`,
      });
    }
    convertedLines.push({
      product: l.product,
      baseUnit,
      enteredUnit,
      enteredQty: l.qty,
      baseQty: round4(baseQty),
      notes: l.notes,
    });
  }

  // Merge duplicate product lines (in base units) so one product can't over-draw
  // the store across two lines while each individually passes the check.
  const merged = new Map();
  for (const l of convertedLines) {
    const key = l.product.toString();
    const cur = merged.get(key);
    if (cur) {
      cur.baseQty = round4(cur.baseQty + l.baseQty);
      cur.multi = true;
    } else {
      merged.set(key, { ...l });
    }
  }
  const lineList = [...merged.values()];

  // Pre-check (fast reject) — the source area must hold enough of every line.
  const shortages = [];
  for (const l of lineList) {
    const key = l.product.toString();
    const available = sourceByProduct[key]?.qtyOnHand ?? 0;
    if (available < l.baseQty) {
      shortages.push({
        product: key,
        name: productByProduct[key]?.name ?? key,
        requested: l.baseQty,
        available: round4(available),
      });
    }
  }
  if (shortages.length > 0) {
    return res.status(409).json({
      success: false,
      message: `Not enough stock in the ${sourceArea} to move the requested quantity.`,
      shortages,
    });
  }

  // Build persisted lines. qty/unit are the canonical base values that move;
  // enteredQty/enteredUnit preserve what the user typed.
  const issueLines = lineList.map((l) => {
    const key = l.product.toString();
    const src = sourceByProduct[key];
    const prod = productByProduct[key];
    const unit = l.baseUnit || src?.unit || prod?.unit || '';
    const unitCost = round2(prod?.currentPrice || 0);
    const enteredUnit = l.multi ? unit : l.enteredUnit;
    const enteredQty = l.multi ? l.baseQty : round4(l.enteredQty);
    return {
      product: l.product,
      qty: l.baseQty,
      unit,
      enteredQty,
      enteredUnit,
      storeQtyBefore: round4(src?.qtyOnHand ?? 0),
      unitCost,
      lineValue: round2(l.baseQty * unitCost),
      notes: l.notes,
    };
  });
  const totalValue = round2(issueLines.reduce((s, l) => s + l.lineValue, 0));

  // Apply SOURCE decrements ATOMICALLY and CONDITIONALLY: the { qtyOnHand: $gte }
  // guard means a decrement only applies if the source still holds enough at write
  // time — closing the check-then-act race where two concurrent transfers could
  // otherwise drive the source negative. The pre-check above stays for a friendly
  // fast-reject; this is the real safety net.
  const sourceResults = await Promise.all(issueLines.map((l) =>
    StockItem.findOneAndUpdate(
      { product: l.product, outlet, area: sourceArea, qtyOnHand: { $gte: l.qty } },
      { $inc: { qtyOnHand: -l.qty }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    ),
  ));

  const failedIdx = sourceResults.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (failedIdx.length > 0) {
    // Roll back the decrements that DID apply so nothing is left half-moved.
    await Promise.all(
      sourceResults
        .map((r, i) => (r
          ? StockItem.findOneAndUpdate(
              { product: issueLines[i].product, outlet, area: sourceArea },
              { $inc: { qtyOnHand: issueLines[i].qty } },
            )
          : null))
        .filter(Boolean),
    );
    const shortages = failedIdx.map((i) => {
      const key = issueLines[i].product.toString();
      return { product: key, name: productByProduct[key]?.name ?? key, requested: issueLines[i].qty };
    });
    return res.status(409).json({
      success: false,
      message: `The ${sourceArea} stock changed while moving — not enough to complete.`,
      shortages,
    });
  }

  // Record the true pre-move source balance from the actual decrement result.
  sourceResults.forEach((r, i) => {
    issueLines[i].storeQtyBefore = round4((r.qtyOnHand ?? 0) + issueLines[i].qty);
  });

  // Persist the transfer as 'in_transit' — the source is already debited; the
  // destination is NOT credited yet (that happens on acceptance). If the create
  // fails we UNDO the source debit so nothing is left half-moved (the "qty
  // deducted but error" bug this guards against).
  let issue;
  try {
    const issueNumber = await generateIssueNumber(numberPrefix);
    issue = await StockIssue.create({
      issueNumber,
      outlet,
      direction,
      lines: issueLines,
      totalValue,
      status: 'in_transit',
      issuedBy: req.user.id,
      notes,
      createdBy: req.user.id,
    });
  } catch (err) {
    // All-or-nothing: restore every source debit.
    await Promise.allSettled(issueLines.map((l) => StockItem.findOneAndUpdate(
      { product: l.product, outlet, area: sourceArea }, { $inc: { qtyOnHand: l.qty } },
    )));
    logger.error(`Stock ${direction} FAILED after source debit — rolled back all changes. code=${err?.code} ${err?.message}`);
    return res.status(500).json({
      success: false,
      message: 'Could not start the transfer — no changes were applied. Please try again.',
    });
  }

  // Ledger (best-effort; never throws): only the source OUT is recorded now. The
  // destination IN row is recorded when the receiver accepts.
  await recordStockMovements(issueLines.map((l) => ({
    product: l.product, outlet, area: sourceArea, qty: -l.qty, unit: l.unit,
    type: outType, unitCost: l.unitCost, ref: { kind: 'stockIssue', id: issue._id }, user: req.user.id,
  })));

  req.auditRecordId = issue._id;
  req.auditAfter = issue.toObject();

  logger.info(`Stock ${direction} ${issue.issueNumber}: ${issueLines.length} line(s) issued from ${sourceArea} (in transit) at outlet ${outlet} by user ${req.user.id}`);

  await issue.populate([
    { path: 'lines.product', select: 'name sku unit' },
    { path: 'issuedBy', select: 'name email' },
  ]);

  emitTransferChanged(req.tenantSlug, { id: String(issue._id), direction, status: 'in_transit', outlet: String(outlet) });

  return res.status(201).json({ success: true, data: issue });
};

// ─── acceptIssue ──────────────────────────────────────────────────────────────
// POST /api/stock-issues/:id/accept
// The RECEIVING area accepts an in-transit transfer: credit the destination and
// mark it 'accepted'. Only the receiver-side manager may accept.
export const acceptIssue = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transfer ID.' });
  }
  const issue = await StockIssue.findById(id);
  if (!issue) return res.status(404).json({ success: false, message: 'Transfer not found.' });
  if (issue.status !== 'in_transit') {
    return res.status(409).json({ success: false, message: 'This transfer is no longer awaiting acceptance.' });
  }

  const { destArea, inType, receiverPerm } = dirMeta(issue.direction);
  if (!req.user.hasPermission(receiverPerm)) {
    return res.status(403).json({ success: false, message: `You need ${destArea} permissions to accept this transfer.` });
  }

  const outlet = issue.outlet;

  // Atomically claim the transfer so two concurrent accepts can't both credit the
  // destination — the loser gets null and is told it's already handled.
  const claimed = await StockIssue.findOneAndUpdate(
    { _id: issue._id, status: 'in_transit' },
    { $set: { status: 'accepted', receivedBy: req.user.id, receivedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    return res.status(409).json({ success: false, message: 'This transfer is no longer awaiting acceptance.' });
  }

  // Credit the destination. If any line fails, reverse the credits already applied
  // and release the claim back to 'in_transit' so it can be retried.
  const applied = [];
  try {
    for (const l of issue.lines) {
      await creditStockUpsert({ product: l.product, outlet, area: destArea, qty: l.qty, unit: l.unit });
      applied.push(l);
    }
  } catch (err) {
    await Promise.allSettled(applied.map((l) => StockItem.findOneAndUpdate(
      { product: l.product, outlet, area: destArea }, { $inc: { qtyOnHand: -l.qty } },
    )));
    await StockIssue.updateOne(
      { _id: issue._id },
      { $set: { status: 'in_transit' }, $unset: { receivedBy: '', receivedAt: '' } },
    );
    logger.error(`Accept of transfer ${issue.issueNumber} FAILED crediting ${destArea} — rolled back. code=${err?.code} ${err?.message}`);
    return res.status(500).json({ success: false, message: 'Could not accept the transfer — no changes were applied. Please try again.' });
  }

  // Ledger (best-effort): the destination IN per line.
  await recordStockMovements(issue.lines.map((l) => ({
    product: l.product, outlet, area: destArea, qty: l.qty, unit: l.unit,
    type: inType, unitCost: l.unitCost, ref: { kind: 'stockIssue', id: issue._id }, user: req.user.id,
  })));

  req.auditRecordId = claimed._id;
  req.auditAfter = claimed.toObject();
  logger.info(`Transfer ${claimed.issueNumber} ACCEPTED into ${destArea} at outlet ${outlet} by user ${req.user.id}`);

  await claimed.populate([
    { path: 'lines.product', select: 'name sku unit' },
    { path: 'issuedBy', select: 'name email' },
    { path: 'receivedBy', select: 'name email' },
  ]);

  emitTransferChanged(req.tenantSlug, { id: String(claimed._id), direction: claimed.direction, status: 'accepted', outlet: String(outlet) });

  return res.json({ success: true, data: claimed });
};

// ─── rejectIssue ──────────────────────────────────────────────────────────────
// POST /api/stock-issues/:id/reject   Body: { reason? }
// The RECEIVING area rejects an in-transit transfer: the stock is returned to the
// SENDER's source area and the transfer is marked 'rejected'.
export const rejectIssue = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transfer ID.' });
  }
  const reason = (req.body?.reason || '').toString().trim();
  const issue = await StockIssue.findById(id);
  if (!issue) return res.status(404).json({ success: false, message: 'Transfer not found.' });
  if (issue.status !== 'in_transit') {
    return res.status(409).json({ success: false, message: 'This transfer is no longer awaiting a decision.' });
  }

  const { sourceArea, destArea, receiverPerm } = dirMeta(issue.direction);
  if (!req.user.hasPermission(receiverPerm)) {
    return res.status(403).json({ success: false, message: `You need ${destArea} permissions to reject this transfer.` });
  }

  const outlet = issue.outlet;

  const claimed = await StockIssue.findOneAndUpdate(
    { _id: issue._id, status: 'in_transit' },
    { $set: { status: 'rejected', receivedBy: req.user.id, receivedAt: new Date(), rejectReason: reason } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    return res.status(409).json({ success: false, message: 'This transfer is no longer awaiting a decision.' });
  }

  // Return the stock to the sender's source area. On failure, reverse what was
  // returned and release the claim so it can be retried.
  const applied = [];
  try {
    for (const l of issue.lines) {
      await creditStockUpsert({ product: l.product, outlet, area: sourceArea, qty: l.qty, unit: l.unit });
      applied.push(l);
    }
  } catch (err) {
    await Promise.allSettled(applied.map((l) => StockItem.findOneAndUpdate(
      { product: l.product, outlet, area: sourceArea }, { $inc: { qtyOnHand: -l.qty } },
    )));
    await StockIssue.updateOne(
      { _id: issue._id },
      { $set: { status: 'in_transit' }, $unset: { receivedBy: '', receivedAt: '', rejectReason: '' } },
    );
    logger.error(`Reject of transfer ${issue.issueNumber} FAILED returning to ${sourceArea} — rolled back. code=${err?.code} ${err?.message}`);
    return res.status(500).json({ success: false, message: 'Could not reject the transfer — no changes were applied. Please try again.' });
  }

  // Ledger (best-effort): a reversal back into the source per line.
  await recordStockMovements(issue.lines.map((l) => ({
    product: l.product, outlet, area: sourceArea, qty: l.qty, unit: l.unit,
    type: 'reversal', unitCost: l.unitCost, ref: { kind: 'stockIssue', id: issue._id }, user: req.user.id,
  })));

  req.auditRecordId = claimed._id;
  req.auditAfter = claimed.toObject();
  logger.info(`Transfer ${claimed.issueNumber} REJECTED — returned to ${sourceArea} at outlet ${outlet} by user ${req.user.id}`);

  await claimed.populate([
    { path: 'lines.product', select: 'name sku unit' },
    { path: 'issuedBy', select: 'name email' },
    { path: 'receivedBy', select: 'name email' },
  ]);

  emitTransferChanged(req.tenantSlug, { id: String(claimed._id), direction: claimed.direction, status: 'rejected', outlet: String(outlet) });

  return res.json({ success: true, data: claimed });
};

// ─── getAllIssues ───────────────────────────────────────────────────────────
// GET /api/stock-issues?outlet=&direction=&status=&from=&to=&page=&limit=
export const getAllIssues = async (req, res) => {
  const { outlet, direction, status, from, to, page = 1, limit = 25 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {};
  if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (direction === 'storeToKitchen' || direction === 'kitchenToStore') filter.direction = direction;
  if (['in_transit', 'accepted', 'rejected', 'confirmed'].includes(status)) filter.status = status;
  if (from || to) {
    filter.createdAt = {};
    if (from) { const f = new Date(from); f.setHours(0, 0, 0, 0); filter.createdAt.$gte = f; }
    if (to)   { const t = new Date(to);   t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
  }

  const [issues, total] = await Promise.all([
    StockIssue.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('lines.product', 'name sku unit')
      .populate('issuedBy', 'name email')
      .populate('receivedBy', 'name email')
      .populate('outlet', 'name code')
      .lean(),
    StockIssue.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { issues, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── getPendingCounts ─────────────────────────────────────────────────────────
// GET /api/stock-issues/pending-counts[?outlet=]
// Cheap countDocuments for the "awaiting acceptance" badges — never truncated by
// a page cap. storePending = kitchen→store (dest store); kitchenPending =
// store→kitchen (dest kitchen).
export const getPendingCounts = async (req, res) => {
  const { outlet } = req.query;
  const base = { status: 'in_transit' };
  if (outlet && mongoose.isValidObjectId(outlet)) base.outlet = new mongoose.Types.ObjectId(outlet);

  const [storePending, kitchenPending] = await Promise.all([
    StockIssue.countDocuments({ ...base, direction: 'kitchenToStore' }),
    StockIssue.countDocuments({ ...base, direction: 'storeToKitchen' }),
  ]);
  return res.json({ success: true, data: { storePending, kitchenPending } });
};

// ─── getIssueById ───────────────────────────────────────────────────────────
// GET /api/stock-issues/:id
export const getIssueById = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid issue ID.' });
  }
  const issue = await StockIssue.findById(id)
    .populate('lines.product', 'name sku unit')
    .populate('issuedBy', 'name email')
    .populate('receivedBy', 'name email')
    .populate('outlet', 'name code')
    .lean();
  if (!issue) {
    return res.status(404).json({ success: false, message: 'Stock issue not found.' });
  }
  return res.json({ success: true, data: issue });
};
