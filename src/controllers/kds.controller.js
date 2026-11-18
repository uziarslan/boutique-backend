import mongoose from 'mongoose';
import { cancelKdsItem, previewKdsItemCancellation } from '../services/kdsItemCancellation.service.js';
import KdsOrder from '../models/KdsOrder.js';
import Outlet from '../models/Outlet.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SaleSession from '../models/SaleSession.js';
import { cancelHeldOrder, voidTransaction, getPosWastePreview } from './sale.controller.js';
import { emitKdsOrder, emitKdsReady, isKdsEnabled } from '../services/kds.service.js';
import { getBusinessDate } from '../utils/businessDate.js';

const actor = (req) => ({ id: req.user.id, name: req.user.name || req.user.email || '' });
const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const durationSeconds = (from, to) => (
  from && to ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000)) : null
);

const resolveOutletId = async (req, requested) => {
  const candidate = requested || req.user.outletRef;
  if (!candidate || !mongoose.isValidObjectId(candidate)) return null;
  if (req.user.role !== 'owner') {
    let permittedOutlet = req.user.outletRef || null;
    if (!permittedOutlet && req.user.outletCode) {
      permittedOutlet = (await Outlet.findOne({ code: req.user.outletCode }).select('_id').lean())?._id || null;
    }
    if (!permittedOutlet) {
      permittedOutlet = (await SaleSession.findOne({ cashier: req.user.id, status: 'open' }).select('outlet').lean())?.outlet || null;
    }
    if (!permittedOutlet || String(candidate) !== String(permittedOutlet)) return null;
  }
  return candidate;
};

const publicOrder = (order) => {
  const row = order?.toObject ? order.toObject() : order;
  return {
    ...row,
    durations: {
      punchToSendSeconds: durationSeconds(row.punchedAt, row.sentToKitchenAt),
      sendToAcceptSeconds: durationSeconds(row.sentToKitchenAt, row.acceptedAt),
      acceptToPrepSeconds: durationSeconds(row.acceptedAt, row.prepStartedAt),
      prepToDispatchSeconds: durationSeconds(row.prepStartedAt, row.kitchenDispatchedAt),
      totalKitchenSeconds: durationSeconds(row.sentToKitchenAt, row.kitchenDispatchedAt),
      cashierResponseSeconds: durationSeconds(row.kitchenDispatchedAt, row.cashierAcknowledgedAt),
      riderAssignmentSeconds: durationSeconds(row.punchedAt, row.riderAssignedAt),
    },
  };
};

export const getKdsConfig = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const outlet = await Outlet.findById(outletId).select('name code kds').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  return res.json({ success: true, data: { outlet, kds: outlet.kds || { enabled: false } } });
};

export const listKdsOrders = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const outlet = await Outlet.findById(outletId)
    .select('name code kds timezone businessDayStart businessDayEnd').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    return res.status(409).json({
      success: false,
      code: 'KDS_DISABLED',
      message: 'KDS is disabled for this outlet.',
      data: { outlet },
    });
  }
  const now = new Date();
  const businessDate = getBusinessDate(
    now, outlet.timezone, outlet.businessDayStart, outlet.businessDayEnd,
  );
  const recentSince = new Date(now.getTime() - 30 * 60 * 1000);
  const orders = await KdsOrder.find({
    outlet: outletId,
    businessDate,
    $or: [
      { currentStatus: { $in: ['new', 'accepted', 'preparing'] } },
      {
        currentStatus: 'dispatched',
        kitchenDispatchedAt: { $gte: recentSince },
        finalSaleTransaction: null,
      },
    ],
  })
    .populate('assignedRider', 'name phone designation')
    .sort({ sentToKitchenAt: 1 })
    .lean();
  return res.json({ success: true, data: { orders: orders.map(publicOrder), outlet, businessDate } });
};

const transition = ({ from, to, eventType, timeField, byField, byNameField, socketEvent = 'kds-order:updated' }) => async (req, res) => {
  const who = actor(req);
  const now = new Date();
  const existing = await KdsOrder.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ success: false, message: 'KDS order not found.' });
  const outletId = await resolveOutletId(req, existing.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This KDS order belongs to another outlet.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) return res.status(409).json({ success: false, code: 'KDS_DISABLED', message: 'KDS is disabled for this outlet.' });

  const update = {
    $set: {
      currentStatus: to,
      [timeField]: now,
      [byField]: who.id,
      [byNameField]: who.name,
    },
    $inc: { version: 1 },
    $push: {
      lifecycle: {
        type: eventType, at: now, actor: who.id, actorName: who.name,
        source: 'kds', fromStatus: from, toStatus: to,
      },
    },
  };
  const order = await KdsOrder.findOneAndUpdate(
    { _id: req.params.id, currentStatus: from },
    update,
    { returnDocument: 'after' },
  );
  if (!order) {
    return res.status(409).json({ success: false, message: `Order must be ${from} before it can become ${to}.` });
  }
  const payload = publicOrder(order);
  emitKdsOrder(req.user.tenantSlug, outletId, socketEvent, payload);
  emitKdsReady(req.user.tenantSlug, outletId, 'kds-order:status', {
    id: String(order._id),
    orderId: String(order.saleTransaction),
    orderNumber: order.ticketNumber,
    orderType: order.orderType,
    currentStatus: order.currentStatus,
  });
  if (to === 'dispatched') {
    emitKdsReady(req.user.tenantSlug, outletId, 'kds-order:ready', {
      id: String(order._id),
      orderId: String(order.saleTransaction),
      orderNumber: order.ticketNumber,
      finalTransactionNumber: order.finalTransactionNumber || '',
      orderType: order.orderType,
      tableNumber: order.tableNumber,
      customerName: order.customerName,
      dispatchedAt: order.kitchenDispatchedAt,
    });
  }
  return res.json({ success: true, data: payload });
};

export const acceptKdsOrder = transition({
  from: 'new', to: 'accepted', eventType: 'accepted',
  timeField: 'acceptedAt', byField: 'acceptedBy', byNameField: 'acceptedByName',
});

export const startKdsPrep = transition({
  from: 'accepted', to: 'preparing', eventType: 'prep-started',
  timeField: 'prepStartedAt', byField: 'prepStartedBy', byNameField: 'prepStartedByName',
});

export const dispatchKdsOrder = transition({
  from: 'preparing', to: 'dispatched', eventType: 'dispatched',
  timeField: 'kitchenDispatchedAt', byField: 'kitchenDispatchedBy', byNameField: 'kitchenDispatchedByName',
});

export const acknowledgeKdsReady = async (req, res) => {
  const who = actor(req);
  const now = new Date();
  const existing = await KdsOrder.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ success: false, message: 'KDS order not found.' });
  const outletId = await resolveOutletId(req, existing.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This order belongs to another outlet.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    return res.status(409).json({ success: false, code: 'KDS_DISABLED', message: 'KDS is disabled for this outlet.' });
  }
  const order = await KdsOrder.findOneAndUpdate(
    { _id: req.params.id, currentStatus: 'dispatched', cashierAcknowledgedAt: null },
    {
      $set: {
        cashierAcknowledgedAt: now,
        cashierAcknowledgedBy: who.id,
        cashierAcknowledgedByName: who.name,
      },
      $inc: { version: 1 },
      $push: { lifecycle: {
        type: 'cashier-acknowledged', at: now, actor: who.id, actorName: who.name,
        source: 'pos', fromStatus: 'dispatched', toStatus: 'dispatched',
      } },
    },
    { returnDocument: 'after' },
  );
  if (!order) {
    const current = await KdsOrder.findById(req.params.id).lean();
    if (current?.cashierAcknowledgedAt) return res.json({ success: true, data: publicOrder(current), alreadyAcknowledged: true });
    return res.status(409).json({ success: false, message: 'Only a dispatched order can be acknowledged.' });
  }
  const payload = publicOrder(order);
  emitKdsOrder(req.user.tenantSlug, outletId, 'kds-order:updated', payload);
  emitKdsReady(req.user.tenantSlug, outletId, 'kds-ready:acknowledged', {
    id: String(order._id), orderNumber: order.ticketNumber, orderType: order.orderType,
  });
  return res.json({ success: true, data: payload });
};

export const getKdsReadyCounts = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    return res.json({ success: true, data: { enabled: false, total: 0, byType: {} } });
  }
  const rows = await KdsOrder.aggregate([
    { $match: { outlet: new mongoose.Types.ObjectId(outletId), currentStatus: 'dispatched', cashierAcknowledgedAt: null } },
    { $group: { _id: '$orderType', count: { $sum: 1 } } },
  ]);
  const byType = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  return res.json({ success: true, data: { enabled: true, total: rows.reduce((sum, row) => sum + row.count, 0), byType } });
};

export const cancelKdsOrder = async (req, res) => {
  const order = await KdsOrder.findById(req.params.id).lean();
  if (!order) return res.status(404).json({ success: false, message: 'KDS order not found.' });
  const outletId = await resolveOutletId(req, order.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This KDS order belongs to another outlet.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    return res.status(409).json({ success: false, code: 'KDS_DISABLED', message: 'KDS is disabled for this outlet.' });
  }
  if (order.currentStatus === 'cancelled') return res.status(409).json({ success: false, message: 'This order is already cancelled.' });
  req.params.id = String(order.saleTransaction);
  req.kdsCancellation = true;
  const sale = await SaleTransaction.findById(order.saleTransaction).select('status').lean();
  if (!sale) return res.status(404).json({ success: false, message: 'Sale order not found.' });
  return sale.status === 'held' ? cancelHeldOrder(req, res) : voidTransaction(req, res);
};

const itemCancellationContext = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    throw Object.assign(new Error('Invalid KDS order ID.'), { statusCode: 400 });
  }
  const order = await KdsOrder.findById(req.params.id).lean();
  if (!order) throw Object.assign(new Error('KDS order not found.'), { statusCode: 404 });
  const outletId = await resolveOutletId(req, order.outlet);
  if (!outletId) throw Object.assign(new Error('This KDS order belongs to another outlet.'), { statusCode: 403 });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    throw Object.assign(new Error('KDS is disabled for this outlet.'), { statusCode: 409 });
  }
  const outlet = await Outlet.findById(outletId).select('timezone businessDayStart businessDayEnd').lean();
  if (!outlet) throw Object.assign(new Error('Outlet not found.'), { statusCode: 404 });
  const businessDate = getBusinessDate(new Date(), outlet.timezone, outlet.businessDayStart, outlet.businessDayEnd);
  if (!['owner', 'financeManager'].includes(req.user.role) && order.businessDate !== businessDate) {
    throw Object.assign(new Error('Ask an owner or finance manager to cancel items from a past business day.'), { statusCode: 409 });
  }
  return { order, outletId, businessDate };
};

export const getKdsItemCancellationPreview = async (req, res) => {
  const { order } = await itemCancellationContext(req);
  const data = await previewKdsItemCancellation({ order, itemIndex: Number(req.params.itemIndex),
    version: req.query.version, qty: Number(req.query.qty ?? 1) });
  return res.json({ success: true, data });
};

export const cancelKdsOrderItem = async (req, res) => {
  const { outletId, businessDate } = await itemCancellationContext(req);
  const data = await cancelKdsItem({
    orderId: req.params.id, outletId, businessDate, itemIndex: Number(req.params.itemIndex),
    version: req.body.version, qty: req.body.qty, prepared: req.body.prepared,
    reason: req.body.voidReason, valuationMethod: req.body.valuationMethod || 'ingredientCost',
    actor: { ...actor(req), role: req.user.role }, tenantSlug: req.user.tenantSlug, ip: req.ip,
  });
  return res.json({ success: true, data: publicOrder(data) });
};

export const getKdsWastePreview = async (req, res) => {
  const order = await KdsOrder.findById(req.params.id).lean();
  if (!order) return res.status(404).json({ success: false, message: 'KDS order not found.' });
  const outletId = await resolveOutletId(req, order.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This KDS order belongs to another outlet.' });
  if (!(await isKdsEnabled(outletId, req.tenant))) {
    return res.status(409).json({ success: false, code: 'KDS_DISABLED', message: 'KDS is disabled for this outlet.' });
  }
  req.params.id = String(order.saleTransaction);
  req.kdsCancellation = true;
  return getPosWastePreview(req, res);
};

const dateFilter = (req) => {
  const filter = {};
  if (req.query.from || req.query.to) {
    filter.businessDate = {};
    if (req.query.from) filter.businessDate.$gte = req.query.from;
    if (req.query.to) filter.businessDate.$lte = req.query.to;
  }
  return filter;
};

const average = (values) => values.length
  ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  : null;

export const getKdsLifecycleReport = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const rows = await KdsOrder.find({ outlet: outletId, ...dateFilter(req) })
    .sort({ sentToKitchenAt: -1 })
    .limit(5000)
    .lean();
  const data = rows.map(publicOrder);
  const metric = (key) => data.map((row) => row.durations[key]).filter((value) => value != null);
  return res.json({
    success: true,
    data: {
      summary: {
        totalOrders: data.length,
        dispatchedOrders: data.filter((row) => row.kitchenDispatchedAt).length,
        cancelledOrders: data.filter((row) => row.currentStatus === 'cancelled').length,
        averageAcceptSeconds: average(metric('sendToAcceptSeconds')),
        averagePrepSeconds: average(metric('prepToDispatchSeconds')),
        averageKitchenSeconds: average(metric('totalKitchenSeconds')),
        averageCashierResponseSeconds: average(metric('cashierResponseSeconds')),
      },
      orders: data,
    },
  });
};

export const getKitchenCounterReport = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const businessDates = dateFilter(req);
  const [kitchenOrders, counterSales] = await Promise.all([
    // Kitchen responsibility is established by the immutable dispatch event,
    // not the ticket's later status. If prepared food is dispatched and the
    // ticket is subsequently cancelled, it must remain visible here so that a
    // missing counter cash-out cannot be concealed by that cancellation.
    // Tickets cancelled before dispatch have no timestamp and are excluded.
    KdsOrder.find({
      outlet: outletId,
      kitchenDispatchedAt: { $ne: null },
      ...businessDates,
    })
      .select('_id saleTransaction originalSaleTransaction finalSaleTransaction ticketNumber finalTransactionNumber businessDate orderType totalAmount kitchenDispatchedAt kitchenDispatchedByName currentStatus cancelledAt cancelledByName cancellationReason')
      .lean(),
    // Counter responsibility is independent of KDS: count every sale that is
    // still completed/paid. Voided and refunded sales intentionally disappear
    // from this side while their dispatched kitchen ticket remains auditable.
    SaleTransaction.find({
      outlet: outletId,
      status: 'completed',
      ...businessDates,
    })
      .select('_id transactionNumber businessDate orderType totalAmount kdsOrder createdAt cashier')
      .populate('cashier', 'name email')
      .lean(),
  ]);

  const kitchenValue = round2(kitchenOrders.reduce(
    (sum, order) => sum + Number(order.totalAmount || 0),
    0,
  ));
  const counterValue = round2(counterSales.reduce(
    (sum, sale) => sum + Number(sale.totalAmount || 0),
    0,
  ));

  // Keep a compact exact-order cross-check as well as the headline totals. A
  // different counter sale with the same value must not be able to conceal a
  // dispatched kitchen order that was never cashed out.
  const completedSaleIds = new Set(counterSales.map((sale) => String(sale._id)));
  const completedKdsIds = new Set(counterSales.map((sale) => String(sale.kdsOrder || '')).filter(Boolean));
  const dispatchedKdsIds = new Set(kitchenOrders.map((order) => String(order._id)));
  const dispatchedSaleIds = new Set();
  for (const order of kitchenOrders) {
    for (const reference of [order.saleTransaction, order.originalSaleTransaction, order.finalSaleTransaction]) {
      if (reference) dispatchedSaleIds.add(String(reference));
    }
  }
  const uncashedKitchenOrders = kitchenOrders.filter((order) => (
    !completedKdsIds.has(String(order._id))
    && ![order.saleTransaction, order.originalSaleTransaction, order.finalSaleTransaction]
      .some((reference) => reference && completedSaleIds.has(String(reference)))
  ));
  const counterWithoutDispatch = counterSales.filter((sale) => (
    !(sale.kdsOrder && dispatchedKdsIds.has(String(sale.kdsOrder)))
    && !dispatchedSaleIds.has(String(sale._id))
  ));
  const discrepancies = [
    ...uncashedKitchenOrders.map((order) => ({
      id: String(order._id),
      kind: 'kitchen-not-cashed',
      orderNumber: order.finalTransactionNumber || order.ticketNumber,
      businessDate: order.businessDate || '',
      orderType: order.orderType || '',
      amount: round2(order.totalAmount),
      eventAt: order.kitchenDispatchedAt,
      responsibleName: order.kitchenDispatchedByName || '',
      currentStatus: order.currentStatus,
      cancelledAt: order.cancelledAt || null,
      cancelledByName: order.cancelledByName || '',
      cancellationReason: order.cancellationReason || '',
    })),
    ...counterWithoutDispatch.map((sale) => ({
      id: String(sale._id),
      kind: 'counter-without-dispatch',
      orderNumber: sale.transactionNumber,
      businessDate: sale.businessDate || '',
      orderType: sale.orderType || '',
      amount: round2(sale.totalAmount),
      eventAt: sale.createdAt,
      responsibleName: sale.cashier?.name || sale.cashier?.email || '',
      currentStatus: 'completed',
    })),
  ].sort((left, right) => new Date(right.eventAt || 0) - new Date(left.eventAt || 0));

  return res.json({
    success: true,
    data: {
      summary: {
        kitchenOrders: kitchenOrders.length,
        kitchenValue,
        counterOrders: counterSales.length,
        counterValue,
        orderVariance: kitchenOrders.length - counterSales.length,
        valueVariance: round2(kitchenValue - counterValue),
        uncashedKitchenOrders: uncashedKitchenOrders.length,
        uncashedKitchenValue: round2(uncashedKitchenOrders.reduce(
          (sum, order) => sum + Number(order.totalAmount || 0),
          0,
        )),
        counterWithoutDispatchOrders: counterWithoutDispatch.length,
        counterWithoutDispatchValue: round2(counterWithoutDispatch.reduce(
          (sum, sale) => sum + Number(sale.totalAmount || 0),
          0,
        )),
      },
      discrepancies,
    },
  });
};
