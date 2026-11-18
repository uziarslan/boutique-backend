import SaleTransaction from '../models/SaleTransaction.js';
import KdsOrder from '../models/KdsOrder.js';
import DeliveryAssignment from '../models/DeliveryAssignment.js';
import { deliveryItemsFromSale, deliveryAssignmentPublic } from './deliveryAssignment.service.js';
import { emitRiderEvent } from './riderTracking.service.js';
import AuditLog from '../models/AuditLog.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { buildKdsItemCancellation, resolveKdsCancellationLine } from '../utils/kdsItemCancellation.js';
import { cancellationOrderSnapshot, findHeldItemCancellations } from '../utils/heldItemCancellation.js';
import { expandDealItemsForKitchen } from './deal.service.js';
import { plainItem, ticketSignature, emitKdsOrder, emitKdsReady } from './kds.service.js';
import { previewSaleWaste, logSaleAsWaste } from './saleWaste.service.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };

export const previewKdsItemCancellation = async ({ order, itemIndex, version, qty }) => {
  const sale = await SaleTransaction.findById(order.saleTransaction).lean();
  if (!sale) fail('Sale order not found.', 404);
  const { saleIndex, item } = resolveKdsCancellationLine(order, sale, itemIndex, version);
  buildKdsItemCancellation(sale, saleIndex, qty);
  const preview = await previewSaleWaste({ transaction: sale, selection: [{ index: saleIndex, qty }] });
  return {
    name: item.name, variationName: item.variation?.name || '',
    isDeal: Boolean(item.dealComponents?.length),
    maxQty: Number(item.qty) - (sale.items.length === 1 ? 1 : 0), qty,
    ingredientCost: preview.recipeCost, orderValue: preview.orderValue,
    saleVersion: Number(sale.kdsItemCancellationVersion || 0),
  };
};

export const cancelKdsItem = async ({ orderId, outletId, itemIndex, version, qty, prepared, reason, valuationMethod, actor, tenantSlug, ip, businessDate }) => {
  if (typeof prepared !== 'boolean') fail('Choose whether this item was already prepared.', 422);
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 300) {
    fail('Enter a cancellation reason between 3 and 300 characters.', 422);
  }
  if (!['ingredientCost', 'orderValue'].includes(valuationMethod)) fail('Choose a valid waste valuation.', 422);
  const session = await getTenantConnection().startSession();
  let updated;
  let assignment;
  try {
    await session.withTransaction(async () => {
      const order = await KdsOrder.findOne({ _id: orderId, outlet: outletId }).session(session);
      if (!order) fail('KDS order not found.', 404);
      const sale = await SaleTransaction.findById(order.saleTransaction).session(session);
      if (!sale) fail('Sale order not found.', 404);
      if (String(sale.outlet) !== String(outletId)) fail('This sale belongs to another outlet.', 403);
      const { saleIndex } = resolveKdsCancellationLine(order, sale, itemIndex, version);
      const before = sale.toObject();
      const plan = buildKdsItemCancellation(before, saleIndex, qty);
      const cancellations = findHeldItemCancellations(before, plan.update.items).map((entry) => ({
        ...entry, prepared, reason: reason.trim(), source: 'kds',
      }));
      // Waste uses the original sale snapshot so removed units retain their
      // recipes/value without marking the remaining active items as wasted.
      const waste = prepared ? await logSaleAsWaste({
        transaction: before, selection: [{ index: saleIndex, qty }],
        reason: 'orderVoid', notes: reason.trim(), userId: actor.id,
        deductStock: true, valuationMethod, requirePositiveValue: true,
        session, persistTransaction: false,
      }) : null;
      Object.assign(sale, plan.update);
      sale.kdsItemCancellationVersion = Number(sale.kdsItemCancellationVersion || 0) + 1;
      await sale.save({ session });
      assignment = await DeliveryAssignment.findOneAndUpdate(
        { saleTransaction: sale._id, active: true },
        { $set: { items: deliveryItemsFromSale(sale.items), totalAmount: sale.totalAmount } },
        { session, returnDocument: 'after' },
      );

      const now = new Date();
      const sequence = Number(order.revisions?.at(-1)?.sequence || 0) + 1;
      order.items = expandDealItemsForKitchen(sale.items).map(plainItem);
      order.subtotal = sale.subtotal;
      order.discountAmount = sale.discountAmount;
      order.totalAmount = sale.totalAmount;
      order.version += 1;
      order.wasteValue = Number(order.wasteValue || 0) + Number(waste?.wasteValue || 0);
      order.revisions.push({ sequence, signature: ticketSignature(sale), sentAt: now,
        sentBy: actor.id, sentByName: actor.name, notes: sale.notes || '', items: order.items });
      order.lifecycle.push({ type: 'item-cancelled', at: now, actor: actor.id,
        actorName: actor.name, source: 'kds', fromStatus: order.currentStatus,
        toStatus: order.currentStatus, reason: reason.trim(),
        metadata: { cancellations, wasteLogId: waste?.wasteLog?._id || null, wasteValue: waste?.wasteValue || 0 } });
      await order.save({ session });
      await AuditLog.create([{
        user: actor.id, actorName: actor.name, actorRole: actor.role,
        action: 'held_order_items_cancelled', module: 'pos', recordId: sale._id, ip,
        before: { transactionNumber: sale.transactionNumber, totalAmount: before.totalAmount },
        after: { transactionNumber: sale.transactionNumber, totalAmount: sale.totalAmount,
          cancellations, orderSnapshot: cancellationOrderSnapshot(sale),
          cancellationBusinessDate: businessDate, source: 'kds', wasteLogId: waste?.wasteLog?._id || null },
      }], { session });
      updated = order.toObject();
    });
  } finally {
    await session.endSession();
  }
  if (assignment) emitRiderEvent({ tenantSlug, outletId, riderId: assignment.rider,
    event: 'rider-assignment:updated', payload: deliveryAssignmentPublic(assignment) });
  emitKdsOrder(tenantSlug, outletId, 'kds-order:revision', updated);
  emitKdsReady(tenantSlug, outletId, 'kds-order:status', {
    id: String(updated._id), orderId: String(updated.saleTransaction),
    orderNumber: updated.ticketNumber, orderType: updated.orderType,
    currentStatus: updated.currentStatus, itemsCancelled: true,
  });
  return updated;
};
