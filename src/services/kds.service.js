import { createHash } from 'crypto';
import KdsOrder from '../models/KdsOrder.js';
import Outlet from '../models/Outlet.js';
import SaleTransaction from '../models/SaleTransaction.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import Customer from '../models/Customer.js';
import DeliveryAssignment from '../models/DeliveryAssignment.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getIo } from '../utils/socket.js';
import logger from '../utils/logger.js';
import { getBusinessDate } from '../utils/businessDate.js';
import { isFeatureEnabledForOutlet } from './outletFeatures.service.js';
import { expandDealItemsForKitchen } from './deal.service.js';

const actorSnapshot = (actor) => ({
  id: actor?.id || actor?._id || null,
  name: actor?.name || actor?.email || '',
});

export const plainItem = (item) => ({
  menuItem: item.menuItem?._id || item.menuItem || null,
  categoryId: item.categoryId?._id || item.categoryId || null,
  categoryName: item.categoryName || '',
  variation: item.variation?.id
    ? { id: item.variation.id, name: item.variation.name || '' }
    : undefined,
  name: item.name,
  qty: Number(item.qty || 0),
  unitPrice: Number(item.unitPrice || 0),
  lineTotal: Number(item.lineTotal || 0),
  discountAmount: Number(item.discountAmount || 0),
  taxAmount: Number(item.taxAmount || 0),
  serviceChargeAmount: Number(item.serviceChargeAmount || 0),
  notes: item.notes || '',
});

export const ticketSignature = (sale) => createHash('sha256').update(JSON.stringify({
  items: (sale.items || []).map((item) => ({
    menuItem: String(item.menuItem?._id || item.menuItem || ''),
    variation: String(item.variation?.id || ''),
    qty: Number(item.qty || 0),
    notes: item.notes || '',
    dealSelections: (item.dealSelections || []).map((selection) => ({
      groupId: String(selection.groupId || ''),
      optionIds: (selection.optionIds || []).map(String).sort(),
    })),
  })),
  notes: sale.notes || '',
})).digest('hex');

export const emitKdsOrder = (tenantSlug, outletId, event, payload) => {
  if (!tenantSlug || !outletId) return;
  getIo()?.to(`kds:${tenantSlug}:${String(outletId)}`).emit(event, payload);
};

export const emitKdsReady = (tenantSlug, outletId, event, payload) => {
  if (!tenantSlug || !outletId) return;
  getIo()?.to(`orders:${tenantSlug}:${String(outletId)}`).emit(event, payload);
};

export const isKdsEnabled = async (outletId, tenantOrSlug) => {
  if (!outletId || !tenantOrSlug) return false;
  const tenant = typeof tenantOrSlug === 'string'
    ? await TenantModel().findOne({ slug: tenantOrSlug }).lean()
    : tenantOrSlug;
  if (!tenant || !isFeatureEnabledForOutlet(tenant, 'kds', outletId)) return false;
  const outlet = await Outlet.findById(outletId).select('kds.enabled').lean();
  return outlet?.kds?.enabled === true;
};

export const ensureKdsOrderForSale = async (
  saleOrId,
  actor,
  { tenantSlug = '', printStatus = 'printed' } = {},
) => {
  const sale = typeof saleOrId?.save === 'function'
    ? saleOrId
    : await SaleTransaction.findById(saleOrId);
  if (!sale || !(await isKdsEnabled(sale.outlet, tenantSlug))) return null;

  const outletClock = await Outlet.findById(sale.outlet)
    .select('timezone businessDayStart businessDayEnd')
    .lean();

  const now = new Date();
  const who = actorSnapshot(actor);
  const items = expandDealItemsForKitchen(sale.items || []).map(plainItem);
  const signature = ticketSignature(sale);
  let kds = await KdsOrder.findOne({ originalSaleTransaction: sale._id });
  let event = 'kds-order:new';

  if (!kds) {
    let cashierName = who.name;
    const [cashier, customer, legacyRider, userRider, riderAssigner] = await Promise.all([
      !cashierName && sale.cashier ? User.findById(sale.cashier).select('name email').lean() : null,
      sale.customer ? Customer.findById(sale.customer?._id || sale.customer).select('name phone').lean() : null,
      sale.assignedRider ? Employee.findById(sale.assignedRider?._id || sale.assignedRider).select('name').lean() : null,
      sale.assignedRiderUser ? User.findById(sale.assignedRiderUser?._id || sale.assignedRiderUser).select('name email').lean() : null,
      sale.assignedRiderBy ? User.findById(sale.assignedRiderBy?._id || sale.assignedRiderBy).select('name email').lean() : null,
    ]);
    cashierName ||= cashier?.name || cashier?.email || '';
    const riderId = sale.assignedRiderUser || sale.assignedRider;
    const resolvedRider = userRider || legacyRider;
    const riderLifecycle = riderId ? [{
      type: 'rider-assigned',
      at: sale.assignedRiderAt || now,
      actor: sale.assignedRiderBy || null,
      actorName: riderAssigner?.name || riderAssigner?.email || '',
      source: 'pos', fromStatus: '', toStatus: 'new',
      metadata: { riderId: String(riderId), riderName: resolvedRider?.name || '', riderType: sale.assignedRiderUser ? 'user' : 'employee' },
    }] : [];
    kds = await KdsOrder.create({
      outlet: sale.outlet,
      saleTransaction: sale._id,
      originalSaleTransaction: sale._id,
      ticketNumber: sale.transactionNumber,
      businessDate: sale.businessDate || getBusinessDate(
        sale.heldAt || sale.createdAt || now,
        outletClock?.timezone,
        outletClock?.businessDayStart,
        outletClock?.businessDayEnd,
      ),
      source: sale.source || 'cashier',
      orderType: sale.orderType || 'dine-in',
      tableNumber: sale.tableNumber || sale.qrOrder?.tableLabel || '',
      customerName: sale.qrOrder?.customerName || sale.foodPandaCustomerName || customer?.name || '',
      customerPhone: sale.qrOrder?.customerPhone || customer?.phone || '',
      deliveryAddress: sale.deliveryAddress?.toObject?.() || sale.deliveryAddress || undefined,
      cashier: sale.cashier || null,
      cashierName,
      notes: sale.notes || '',
      items,
      subtotal: Number(sale.subtotal || 0),
      discountAmount: Number(sale.discountAmount || 0),
      totalAmount: Number(sale.totalAmount || 0),
      punchedAt: sale.heldAt || sale.createdAt || now,
      sentToKitchenAt: now,
      assignedRider: sale.assignedRider || null,
      assignedRiderUser: sale.assignedRiderUser || null,
      assignedRiderName: resolvedRider?.name || '',
      riderAssignedAt: sale.assignedRiderAt || null,
      riderAssignedBy: sale.assignedRiderBy || null,
      riderAssignedByName: riderAssigner?.name || riderAssigner?.email || '',
      printStatus,
      revisions: [{
        sequence: 1,
        signature,
        sentAt: now,
        sentBy: who.id,
        sentByName: who.name,
        notes: sale.notes || '',
        items,
      }],
      lifecycle: [...riderLifecycle, {
        type: 'sent', at: now, actor: who.id, actorName: who.name,
        source: 'pos', fromStatus: '', toStatus: 'new',
      }],
    }).catch(async (error) => {
      if (error?.code !== 11000) throw error;
      event = 'kds-order:updated';
      return KdsOrder.findOne({ originalSaleTransaction: sale._id });
    });
    if (!kds) throw new Error('KDS ticket could not be recovered after a concurrent send.');
  } else {
    const last = kds.revisions?.[kds.revisions.length - 1];
    kds.printStatus = printStatus;
    kds.saleTransaction = sale._id;
    kds.items = items;
    kds.notes = sale.notes || '';
    kds.subtotal = Number(sale.subtotal || 0);
    kds.discountAmount = Number(sale.discountAmount || 0);
    kds.totalAmount = Number(sale.totalAmount || 0);
    if (last?.signature !== signature) {
      const sequence = (last?.sequence || 0) + 1;
      const previousStatus = kds.currentStatus;
      if (previousStatus === 'dispatched') {
        kds.currentStatus = 'new';
        kds.sentToKitchenAt = now;
        kds.acceptedAt = null;
        kds.acceptedBy = null;
        kds.acceptedByName = '';
        kds.prepStartedAt = null;
        kds.prepStartedBy = null;
        kds.prepStartedByName = '';
        kds.kitchenDispatchedAt = null;
        kds.kitchenDispatchedBy = null;
        kds.kitchenDispatchedByName = '';
        kds.cashierAcknowledgedAt = null;
        kds.cashierAcknowledgedBy = null;
        kds.cashierAcknowledgedByName = '';
      }
      kds.revisions.push({
        sequence, signature, sentAt: now, sentBy: who.id,
        sentByName: who.name, notes: sale.notes || '', items,
      });
      kds.lifecycle.push({
        type: 'revised', at: now, actor: who.id, actorName: who.name,
        source: 'pos', fromStatus: previousStatus, toStatus: kds.currentStatus,
        metadata: { sequence },
      });
      kds.version += 1;
      event = 'kds-order:revision';
    } else {
      event = 'kds-order:updated';
    }
    await kds.save();
  }

  if (String(sale.kdsOrder || '') !== String(kds._id)) {
    sale.kdsOrder = kds._id;
    await sale.save();
  }
  const payload = kds.toObject();
  emitKdsOrder(tenantSlug, sale.outlet, event, payload);
  if (event === 'kds-order:revision') {
    emitKdsReady(tenantSlug, sale.outlet, 'kds-order:status', {
      id: String(kds._id), orderId: String(kds.saleTransaction),
      orderNumber: kds.ticketNumber, orderType: kds.orderType,
      currentStatus: kds.currentStatus,
    });
  }
  return payload;
};

export const kdsHasAcceptedSale = async (saleId) => Boolean(await KdsOrder.exists({
  $and: [
    { $or: [
      { saleTransaction: saleId },
      { originalSaleTransaction: saleId },
      { finalSaleTransaction: saleId },
    ] },
    { $or: [
      { currentStatus: { $in: ['accepted', 'preparing', 'dispatched'] } },
      { 'lifecycle.type': 'accepted' },
    ] },
  ],
}));

export const kdsCancellationState = (ticket) => {
  if (!ticket) return null;
  const hasBeenAccepted = Boolean(ticket.acceptedAt)
    || ['accepted', 'preparing', 'dispatched'].includes(ticket.currentStatus)
    || (ticket.lifecycle || []).some((event) => event.type === 'accepted');
  return { ...ticket, hasBeenAccepted, cancellationRequiresKitchen: hasBeenAccepted };
};

export const getSaleKdsCancellationState = async (sale, tenant) => {
  if (!sale?._id || !(await isKdsEnabled(sale.outlet, tenant))) return null;
  return kdsCancellationState(await KdsOrder.findOne({
    $or: [
      { saleTransaction: sale._id },
      { originalSaleTransaction: sale._id },
      { finalSaleTransaction: sale._id },
    ],
  }).select('_id currentStatus acceptedAt lifecycle.type').lean());
};

export const getSalesKdsCancellationStates = async (sales, outletId, tenant) => {
  const states = new Map();
  if (!sales.length || !(await isKdsEnabled(outletId, tenant))) return states;
  const ids = sales.map((sale) => sale._id);
  const tickets = await KdsOrder.find({ outlet: outletId, $or: [
    { saleTransaction: { $in: ids } },
    { originalSaleTransaction: { $in: ids } },
    { finalSaleTransaction: { $in: ids } },
  ] }).select('_id saleTransaction originalSaleTransaction finalSaleTransaction currentStatus acceptedAt lifecycle.type').lean();
  for (const ticket of tickets) {
    for (const id of [ticket.saleTransaction, ticket.originalSaleTransaction, ticket.finalSaleTransaction]) {
      if (id) states.set(String(id), kdsCancellationState(ticket));
    }
  }
  return states;
};

// Only the authenticated KDS controller can set the trusted kitchen flag.
// Client request bodies and cashier/owner roles cannot bypass this rule.
export const assertPosCancellationAllowed = async (sale, tenant, { fromKitchen = false } = {}) => {
  if (fromKitchen) return;
  const kds = await getSaleKdsCancellationState(sale, tenant);
  if (!kds?.cancellationRequiresKitchen) return;
  const code = 'KDS_CANCELLATION_REQUIRED';
  throw Object.assign(new Error('Kitchen has accepted this order. Cancel it from KDS so kitchen staff can confirm whether it was prepared.'), {
    statusCode: 409, code, syncCode: code,
  });
};

export const syncKdsCancellation = async ({
  saleId,
  actor,
  tenantSlug,
  source = 'pos',
  reason = '',
  prepared = false,
  wasteValue = 0,
}) => {
  const who = actorSnapshot(actor);
  const now = new Date();
  const kds = await KdsOrder.findOne({
    $or: [
      { saleTransaction: saleId },
      { originalSaleTransaction: saleId },
      { finalSaleTransaction: saleId },
    ],
  });
  if (!kds || kds.currentStatus === 'cancelled') return kds;
  const previous = kds.currentStatus;
  kds.currentStatus = 'cancelled';
  kds.cancelledAt = now;
  kds.cancelledBy = who.id;
  kds.cancelledByName = who.name;
  kds.cancelledFrom = source;
  kds.cancellationReason = reason;
  kds.statusAtCancellation = previous;
  kds.preparedAtCancellation = prepared;
  kds.wasteValue = Number(kds.wasteValue || 0) + Number(wasteValue || 0);
  kds.version += 1;
  kds.lifecycle.push({
    type: 'cancelled', at: now, actor: who.id, actorName: who.name,
    source, fromStatus: previous, toStatus: 'cancelled', reason,
    metadata: { prepared, wasteValue: Number(wasteValue || 0) },
  });
  await kds.save();
  const payload = kds.toObject();
  emitKdsOrder(tenantSlug, kds.outlet, 'kds-order:cancelled', payload);
  emitKdsReady(tenantSlug, kds.outlet, 'kds-order:cancelled', {
    id: String(kds._id), orderId: String(saleId), orderNumber: kds.ticketNumber,
    orderType: kds.orderType,
  });
  return kds;
};

export const syncKdsRiderAssignment = async ({ sale, employee, actor, tenantSlug }) => {
  const who = actorSnapshot(actor);
  const kds = await KdsOrder.findOne({
    $or: [{ saleTransaction: sale._id }, { originalSaleTransaction: sale._id }],
  });
  if (!kds) return null;
  const now = sale.assignedRiderAt || new Date();
  kds.assignedRider = employee._id;
  kds.assignedRiderUser = null;
  kds.assignedRiderName = employee.name || '';
  kds.riderAssignedAt = now;
  kds.riderAssignedBy = who.id;
  kds.riderAssignedByName = who.name;
  kds.version += 1;
  kds.lifecycle.push({
    type: 'rider-assigned', at: now, actor: who.id, actorName: who.name,
    source: 'pos', fromStatus: kds.currentStatus, toStatus: kds.currentStatus,
    metadata: { riderId: String(employee._id), riderName: employee.name || '' },
  });
  await kds.save();
  emitKdsOrder(tenantSlug, kds.outlet, 'kds-order:updated', kds.toObject());
  return kds;
};

export const relinkKdsOrderToFinalSale = async ({ held, transaction, actor, tenantSlug }) => {
  if (!held?._id || !transaction?._id) return null;
  const who = actorSnapshot(actor);
  const now = new Date();
  const kds = await KdsOrder.findOne({ originalSaleTransaction: held._id });
  if (!kds) return null;
  kds.saleTransaction = transaction._id;
  kds.finalSaleTransaction = transaction._id;
  kds.finalTransactionNumber = transaction.transactionNumber;
  kds.version += 1;
  kds.lifecycle.push({
    type: 'relinked', at: now, actor: who.id, actorName: who.name,
    source: 'system', fromStatus: kds.currentStatus, toStatus: kds.currentStatus,
    metadata: { finalTransactionNumber: transaction.transactionNumber },
  });
  await kds.save();
  await SaleTransaction.updateOne(
    { _id: transaction._id },
    {
      $set: {
        kdsOrder: kds._id,
        assignedRider: held.assignedRider || null,
        assignedRiderUser: held.assignedRiderUser || null,
        assignedRiderAt: held.assignedRiderAt || null,
        assignedRiderBy: held.assignedRiderBy || null,
        riderDeliveryStatus: held.riderDeliveryStatus || undefined,
      },
    },
  );
  await DeliveryAssignment.updateMany(
    { saleTransaction: held._id },
    { $set: { saleTransaction: transaction._id, kdsOrder: kds._id, orderNumber: transaction.transactionNumber } },
  );
  const payload = kds.toObject();
  emitKdsOrder(tenantSlug, kds.outlet, 'kds-order:updated', payload);
  // A dedicated event lets the kitchen board remove a dispatched ticket the
  // instant the cashier settles it. The normal update remains for lifecycle
  // consumers, while the REST list excludes settled dispatched tickets too.
  emitKdsOrder(tenantSlug, kds.outlet, 'kds-order:checked-out', payload);
  return kds;
};

export const reportKdsError = (context, error) => {
  logger.error(`[KDS] ${context}: ${error?.message || error}`);
};
