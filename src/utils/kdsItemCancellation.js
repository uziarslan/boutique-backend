import { expandDealItemsForKitchen } from '../services/deal.service.js';
import { normalizePrintedQuantityMap } from './kitchenPrintedQuantity.js';

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const identity = (item) => JSON.stringify([
  String(item.menuItem?._id || item.menuItem || ''), String(item.variation?.id || ''),
  item.name, Number(item.qty), item.notes || '',
]);

// Recheck at save time as well as request validation: a kitchen cancellation
// may commit while a cashier is calculating the checkout totals.
export const kitchenCancellationWriteFilter = (sale) => ({
  kdsItemCancellationVersion: Number(sale?.kdsItemCancellationVersion || 0) > 0
    ? Number(sale.kdsItemCancellationVersion) : { $in: [0, null] },
});

export const assertKitchenCancellationVersion = (sale, version) => {
  if (Number(sale?.kdsItemCancellationVersion || 0) !== Number(version || 0)) {
    fail('Kitchen items changed. Reopen this held order before saving or taking payment.');
  }
};

// Resolve the displayed kitchen row back to its commercial sale line. Deal
// components must cancel the parent deal together, never an unrelated menu line.
export const resolveKdsCancellationLine = (order, sale, itemIndex, version) => {
  if (!['new', 'accepted', 'preparing', 'dispatched'].includes(order.currentStatus)
    || order.finalSaleTransaction || sale.status !== 'held') {
    fail('Only an active, unpaid kitchen order can have individual items cancelled.');
  }
  if (Number(version) !== Number(order.version) || !Number.isInteger(Number(version))) {
    fail('This kitchen order changed. Refresh it before cancelling an item.');
  }
  if (sale.qrOrder?.pendingAddOn?.items?.length) {
    fail('Approve or decline the pending QR add-on before cancelling an item.');
  }
  const expanded = sale.items.flatMap((item, saleIndex) => (
    expandDealItemsForKitchen([item]).map((kitchenItem) => ({ kitchenItem, saleIndex }))
  ));
  if (expanded.length !== order.items.length || expanded.some(({ kitchenItem }, index) => (
    identity(kitchenItem) !== identity(order.items[index])
  ))) {
    fail('The POS order has changed. Send its updated kitchen ticket before cancelling an item.');
  }
  if (!Number.isInteger(itemIndex) || !expanded[itemIndex]) fail('Choose a valid kitchen item.', 422);
  const saleIndex = expanded[itemIndex].saleIndex;
  return { saleIndex, item: sale.items[saleIndex] };
};

// Preserve stored prices and rates. Reduce only the chosen line's monetary
// amounts, then recalculate the bill using the existing fixed/percent rules.
export const buildKdsItemCancellation = (sale, saleIndex, qty) => {
  const originalItems = sale.items.map((item) => item.toObject?.() || { ...item });
  const original = originalItems[saleIndex];
  if (!original || !Number.isInteger(qty) || qty < 1 || qty > Number(original.qty)) {
    fail('Choose a cancellation quantity between 1 and the item quantity.', 422);
  }
  if (originalItems.length === 1 && qty === Number(original.qty)) {
    fail('This is the final item. Use Cancel order to cancel the entire order.');
  }
  if (Number(original.wastedQty || 0) > 0) {
    fail('This item already has recorded waste. Review it in the POS before cancelling.');
  }
  const ratio = qty / original.qty;
  const cancelled = { ...original, qty, wastedQty: 0 };
  const remaining = { ...original, qty: original.qty - qty };
  for (const field of ['lineTotal', 'taxAmount', 'serviceChargeAmount', 'discountAmount']) {
    cancelled[field] = round2(Number(original[field] || 0) * ratio);
    remaining[field] = round2(Number(original[field] || 0) - cancelled[field]);
  }
  const items = originalItems.flatMap((item, index) => index !== saleIndex ? [item] : remaining.qty > 0 ? [remaining] : []);
  const sum = (rows, field) => round2(rows.reduce((total, item) => total + Number(item[field] || 0), 0));
  const subtotal = sum(items, 'lineTotal');
  const taxAmount = sum(items, 'taxAmount');
  const serviceChargeAmount = sum(items, 'serviceChargeAmount');
  const itemDiscount = sum(items, 'discountAmount');
  const delivery = Number(sale.deliveryChargeAmount || 0);
  const previousOrderDiscount = Math.max(0, round2(sale.discountAmount - sum(originalItems, 'discountAmount')));
  const orderDiscount = sale.discountMode === 'percent'
    ? round2(subtotal * Number(sale.discountPercent || 0) / 100) : previousOrderDiscount;
  const discountAmount = round2(itemDiscount + Math.min(orderDiscount, Math.max(0, subtotal + taxAmount + serviceChargeAmount + delivery - itemDiscount)));
  const totalAmount = round2(Math.max(0, subtotal + taxAmount + serviceChargeAmount + delivery - discountAmount));
  const baseline = normalizePrintedQuantityMap(originalItems, sale.kitchenPrintedQtyMap, {
    assumeAllPrinted: Boolean(sale.kitchenPrintedAt || sale.kitchenPrintQueuedAt),
  });
  return {
    cancelled,
    update: { items, subtotal, taxAmount, serviceChargeAmount, discountAmount, totalAmount,
      kitchenPrintedQtyMap: normalizePrintedQuantityMap(items, baseline) },
  };
};
