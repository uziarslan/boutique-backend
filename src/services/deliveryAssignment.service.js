import DeliveryAssignment from '../models/DeliveryAssignment.js';
import Customer from '../models/Customer.js';
import KdsOrder from '../models/KdsOrder.js';
import RiderEvent from '../models/RiderEvent.js';
import RiderShift from '../models/RiderShift.js';
import { emitRiderEvent } from './riderTracking.service.js';
import { sendRiderAssignmentPush } from './riderPush.service.js';
import { assignmentRunDefaults } from './riderDeliveryRun.service.js';
import logger from '../utils/logger.js';

const riderName = (rider) => rider?.name || rider?.email || 'Rider';

const plainObject = (value) => value?.toObject ? value.toObject() : value;
const idString = (value) => {
  const id = value?._id || value;
  return id == null ? null : String(id);
};

const deliveryAddressFrom = (value) => {
  const address = plainObject(value) || {};
  const hasLatitude = address.latitude !== null && address.latitude !== undefined && address.latitude !== '';
  const hasLongitude = address.longitude !== null && address.longitude !== undefined && address.longitude !== '';
  const latitude = hasLatitude ? Number(address.latitude) : Number.NaN;
  const longitude = hasLongitude ? Number(address.longitude) : Number.NaN;
  return {
    label: String(address.label || '').trim(),
    street: String(address.street || '').trim(),
    area: String(address.area || '').trim(),
    city: String(address.city || '').trim(),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
};

export const deliveryItemsFromSale = (items = []) => (Array.isArray(items) ? items : [])
  .map((value) => {
    const item = plainObject(value) || {};
    const qty = Number(item.qty || 0);
    const variation = plainObject(item.variation) || {};
    return {
      menuItem: item.menuItem?._id || item.menuItem || null,
      name: String(item.name || '').trim(),
      variation: {
        id: variation.id?._id || variation.id || null,
        name: String(variation.name || '').trim(),
      },
      qty,
      unitPrice: Math.max(0, Number(item.unitPrice || 0)),
      lineTotal: Math.max(0, Number(item.lineTotal || 0)),
      notes: String(item.notes || '').trim().slice(0, 300),
    };
  })
  .filter((item) => item.name && Number.isFinite(item.qty) && item.qty > 0);

export const deliveryAssignmentSnapshot = (saleValue, customerValue = null) => {
  const sale = plainObject(saleValue) || {};
  const customer = plainObject(customerValue) || {};
  return {
    businessDate: String(sale.businessDate || '').trim() || null,
    orderNumber: String(sale.transactionNumber || '').trim(),
    customerName: String(customer.name || sale.qrOrder?.customerName || sale.foodPandaCustomerName || '').trim(),
    customerPhone: String(customer.phone || sale.qrOrder?.customerPhone || '').trim(),
    deliveryAddress: deliveryAddressFrom(sale.deliveryAddress),
    items: deliveryItemsFromSale(sale.items),
    deliveryChargeAmount: Math.max(0, Number(sale.deliveryChargeAmount || 0)),
    totalAmount: Math.max(0, Number(sale.totalAmount || 0)),
    notes: String(sale.notes || '').trim().slice(0, 500),
  };
};

export const DELIVERY_ASSIGNMENT_SALE_POPULATE = {
  path: 'saleTransaction',
  select: 'transactionNumber businessDate customer deliveryAddress items deliveryChargeAmount totalAmount notes qrOrder foodPandaCustomerName',
  populate: { path: 'customer', select: 'name phone' },
};

export const deliveryAssignmentPublic = (assignmentValue) => {
  const row = plainObject(assignmentValue) || {};
  const populatedSale = row.saleTransaction
    && typeof row.saleTransaction === 'object'
    && (row.saleTransaction.transactionNumber !== undefined || row.saleTransaction.items !== undefined)
    ? plainObject(row.saleTransaction)
    : null;
  const populatedCustomer = populatedSale?.customer
    && typeof populatedSale.customer === 'object'
    ? populatedSale.customer
    : null;
  const snapshot = populatedSale
    ? deliveryAssignmentSnapshot(populatedSale, populatedCustomer)
      : {
        businessDate: row.businessDate || null,
        orderNumber: row.orderNumber || '',
        customerName: row.customerName || '',
        customerPhone: row.customerPhone || '',
        deliveryAddress: deliveryAddressFrom(row.deliveryAddress),
        items: deliveryItemsFromSale(row.items),
        deliveryChargeAmount: Math.max(0, Number(row.deliveryChargeAmount || 0)),
        totalAmount: Math.max(0, Number(row.totalAmount || 0)),
        notes: row.notes || '',
      };
  const rider = row.rider && typeof row.rider === 'object'
    ? {
        _id: idString(row.rider),
        name: row.rider.name || '',
        email: row.rider.email || '',
      }
    : idString(row.rider);
  const deliveryOutcome = row.deliveryOutcome
    || (['delivered', 'delivery_failed'].includes(row.status) ? row.status : '')
    || [...(row.statusHistory || [])].reverse().find((event) => ['delivered', 'delivery_failed'].includes(event.status))?.status
    || '';
  return {
    _id: idString(row._id),
    saleTransaction: idString(populatedSale || row.saleTransaction),
    kdsOrder: idString(row.kdsOrder),
    outlet: idString(row.outlet),
    rider,
    assignedBy: idString(row.assignedBy),
    assignedAt: row.assignedAt || null,
    ...snapshot,
    status: row.status,
    active: row.active === true,
    deliveryRunId: row.deliveryRunId || '',
    pickupState: row.pickupState || 'queued_at_restaurant',
    queuedAtRestaurantAt: row.queuedAtRestaurantAt || null,
    readyForPickupAt: row.readyForPickupAt || null,
    runStartedAt: row.runStartedAt || null,
    routeSequence: Number(row.routeSequence || 0),
    routeStartedAt: row.routeStartedAt || null,
    routeEndedAt: row.routeEndedAt || null,
    routePointCount: Number(row.routePointCount || 0),
    routeDistanceMeters: Number(row.routeDistanceMeters || 0),
    routeStartLocation: deliveryAddressFrom(row.routeStartLocation),
    routeEndLocation: deliveryAddressFrom(row.routeEndLocation),
    deliveryOutcome,
    runReturnedAt: row.runReturnedAt
      || [...(row.statusHistory || [])].reverse().find((event) => event.status === 'returned_to_restaurant')?.at
      || null,
    completedAt: row.completedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
};

export const syncUserRiderAssignment = async ({ sale, tenantSlug }) => {
  if (!sale?._id) return null;
  const assignment = await DeliveryAssignment.findOne({ saleTransaction: sale._id, active: true });
  if (!assignment) return null;
  const customerId = sale.customer?._id || sale.customer;
  const customer = customerId
    ? await Customer.findById(customerId).select('name phone').lean()
    : null;
  assignment.set(deliveryAssignmentSnapshot(sale, customer));
  await assignment.save();
  const payload = deliveryAssignmentPublic(assignment);
  emitRiderEvent({
    tenantSlug,
    outletId: assignment.outlet,
    riderId: assignment.rider,
    event: 'rider-assignment:updated',
    payload,
  });
  return payload;
};

/**
 * Reserves the order's active assignment slot before changing Sale/KDS
 * projections. A rider may intentionally have several active orders, while the
 * saleTransaction partial unique index still prevents two active riders for
 * the same order.
 */
export const assignUserRider = async ({ sale, rider, actor, tenantSlug }) => {
  const now = new Date();
  const actorId = actor?.id || actor?._id;
  const actorName = actor?.name || actor?.email || '';
  const [customer, previous, kdsOrder, shift] = await Promise.all([
    sale.customer
      ? Customer.findById(sale.customer?._id || sale.customer).select('name phone').lean()
      : null,
    DeliveryAssignment.findOne({ saleTransaction: sale._id, active: true }),
    sale.kdsOrder
      ? KdsOrder.findById(sale.kdsOrder)
      : KdsOrder.findOne({
          $or: [{ saleTransaction: sale._id }, { originalSaleTransaction: sale._id }, { finalSaleTransaction: sale._id }],
        }),
    RiderShift.findOne({ rider: rider._id, status: 'active' })
      .select('_id inOutletGeofence lastLocation')
      .lean(),
  ]);

  if (previous && String(previous.rider) === String(rider._id)) {
    previous.set(deliveryAssignmentSnapshot(sale, customer));
    await previous.save();
    emitRiderEvent({
      tenantSlug,
      outletId: previous.outlet,
      riderId: previous.rider,
      event: 'rider-assignment:updated',
      payload: deliveryAssignmentPublic(previous),
    });
    return previous;
  }

  const previousState = previous
    ? { status: previous.status, completedAt: previous.completedAt }
    : null;
  // Free the order's unique active slot before creating its replacement.
  if (previous) {
    previous.active = false;
    await previous.save();
  }

  let assignment;
  try {
    const runDefaults = await assignmentRunDefaults({ riderId: rider._id, shift, now });
    assignment = await DeliveryAssignment.create({
      saleTransaction: sale._id,
      kdsOrder: kdsOrder?._id || sale.kdsOrder || null,
      outlet: sale.outlet,
      rider: rider._id,
      assignedBy: actorId,
      assignedAt: now,
      ...deliveryAssignmentSnapshot(sale, customer),
      status: 'assigned',
      active: true,
      ...runDefaults,
      statusHistory: [{ status: 'assigned', at: now, actor: actorId, actorName }],
    });
  } catch (error) {
    if (previous) {
      previous.active = true;
      await previous.save().catch(() => {});
    }
    throw error;
  }

  try {
    sale.assignedRider = null;
    sale.assignedRiderUser = rider._id;
    sale.assignedRiderAt = now;
    sale.assignedRiderBy = actorId;
    sale.riderDeliveryStatus = 'assigned';
    await sale.save();
  } catch (error) {
    assignment.active = false;
    assignment.status = 'cancelled';
    assignment.completedAt = new Date();
    await assignment.save().catch(() => {});
    if (previous) {
      previous.active = true;
      previous.status = previousState.status;
      previous.completedAt = previousState.completedAt;
      await previous.save().catch(() => {});
    }
    throw error;
  }

  if (previous) {
    previous.status = 'reassigned';
    previous.pickupState = 'completed';
    previous.completedAt = now;
    previous.statusHistory.push({
      status: 'reassigned', at: now, actor: actorId, actorName,
      reason: `Reassigned to ${riderName(rider)}`,
    });
    await previous.save();
    emitRiderEvent({
      tenantSlug,
      outletId: sale.outlet,
      riderId: previous.rider,
      event: 'rider-assignment:reassigned',
      payload: deliveryAssignmentPublic(previous),
    });
  }

  // Assignment history is independent from websocket delivery, so management
  // can still audit dispatch activity after clients reconnect.
  await Promise.allSettled([
    previous
      ? RiderEvent.create({
          rider: previous.rider,
          outlet: sale.outlet,
          assignment: previous._id,
          type: 'assignment_reassigned',
          metadata: { orderNumber: sale.transactionNumber, reassignedTo: String(rider._id), actorName },
        })
      : Promise.resolve(),
    RiderEvent.create({
      rider: rider._id,
      outlet: sale.outlet,
      assignment: assignment._id,
      type: 'assignment_created',
      metadata: { orderNumber: sale.transactionNumber, actorName },
    }),
  ]);

  if (kdsOrder) {
    kdsOrder.assignedRider = null;
    kdsOrder.assignedRiderUser = rider._id;
    kdsOrder.assignedRiderName = riderName(rider);
    kdsOrder.riderAssignedAt = now;
    kdsOrder.riderAssignedBy = actorId;
    kdsOrder.riderAssignedByName = actorName;
    kdsOrder.version += 1;
    kdsOrder.lifecycle.push({
      type: 'rider-assigned', at: now, actor: actorId, actorName,
      source: 'pos', fromStatus: kdsOrder.currentStatus, toStatus: kdsOrder.currentStatus,
      metadata: { riderId: String(rider._id), riderName: riderName(rider), riderType: 'user' },
    });
    await kdsOrder.save();
  }

  const payload = {
    ...deliveryAssignmentPublic(assignment),
    rider: { _id: String(rider._id), name: riderName(rider), email: rider.email || '' },
  };
  emitRiderEvent({
    tenantSlug,
    outletId: sale.outlet,
    riderId: rider._id,
    event: 'rider-assignment:new',
    payload,
  });
  await sendRiderAssignmentPush({riderId: rider._id, assignment: payload})
    .catch((error) => logger.warn(`[RIDER PUSH] Order ${sale.transactionNumber}: ${error?.message || error}`));
  return assignment;
};

export const cancelUserRiderAssignment = async ({ saleId, actor, tenantSlug, reason, status = 'cancelled' }) => {
  const assignment = await DeliveryAssignment.findOne({ saleTransaction: saleId, active: true });
  if (!assignment) return null;
  const now = new Date();
  const actorId = actor?.id || actor?._id || null;
  const actorName = actor?.name || actor?.email || '';
  assignment.active = false;
  const nextStatus = status === 'reassigned' ? 'reassigned' : 'cancelled';
  assignment.status = nextStatus;
  assignment.pickupState = 'completed';
  assignment.completedAt = now;
  assignment.statusHistory.push({
    status: nextStatus,
    at: now,
    actor: actorId,
    actorName,
    reason: String(reason || (nextStatus === 'reassigned' ? 'Order reassigned' : 'Order cancelled')).slice(0, 500),
  });
  await assignment.save();
  await RiderEvent.create({
    rider: assignment.rider,
    outlet: assignment.outlet,
    assignment: assignment._id,
    type: nextStatus === 'reassigned' ? 'assignment_reassigned' : 'delivery_status',
    metadata: { status: nextStatus, orderNumber: assignment.orderNumber, reason },
  }).catch(() => {});
  emitRiderEvent({
    tenantSlug,
    outletId: assignment.outlet,
    riderId: assignment.rider,
    event: nextStatus === 'reassigned' ? 'rider-assignment:reassigned' : 'rider-assignment:updated',
    payload: deliveryAssignmentPublic(assignment),
  });
  return assignment;
};

export default {
  assignUserRider,
  cancelUserRiderAssignment,
  deliveryAssignmentPublic,
  deliveryAssignmentSnapshot,
  deliveryItemsFromSale,
  syncUserRiderAssignment,
};
