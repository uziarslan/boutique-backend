import {
  buildItemQuantityMap,
  kitchenLineKey,
  normalizePrintedQuantityMap,
} from './kitchenPrintedQuantity.js';

const asPlainItem = (item) => (
  item && typeof item.toObject === 'function' ? item.toObject() : (item || {})
);

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const canCancelKitchenSentItems = (user) => {
  if (user?.role === 'owner') return true;
  const permissions = user?.permissions;
  if (permissions instanceof Map) {
    return permissions.get('pos.cancelSentItem') === true
      || permissions.get('pos___cancelSentItem') === true;
  }
  return permissions?.['pos.cancelSentItem'] === true
    || permissions?.pos___cancelSentItem === true;
};

// Saved quantities are cancellations even before a kitchen ticket is sent.
// Additions above the saved baseline remain ordinary cart edits.
export const findHeldItemCancellations = (heldOrder, requestedItems = []) => {
  if (!heldOrder) return [];

  const printedQuantities = normalizePrintedQuantityMap(
    heldOrder.items || [],
    heldOrder.kitchenPrintedQtyMap,
    { assumeAllPrinted: Boolean(heldOrder.kitchenPrintedAt || heldOrder.kitchenPrintQueuedAt) },
  );
  const requestedQuantities = buildItemQuantityMap(requestedItems);
  const savedQuantities = buildItemQuantityMap(heldOrder.items || []);
  const originalByKey = new Map();

  for (const source of heldOrder.items || []) {
    const item = asPlainItem(source);
    const key = kitchenLineKey(item);
    if (!originalByKey.has(key)) originalByKey.set(key, item);
  }

  return Object.entries(savedQuantities).flatMap(([lineKey, savedQty]) => {
    const printedQty = Math.max(0, Number(printedQuantities[lineKey]) || 0);
    const requestedQty = Math.max(0, Number(requestedQuantities[lineKey]) || 0);
    if (requestedQty >= savedQty) return [];

    const original = originalByKey.get(lineKey) || {};
    const cancelledQty = savedQty - requestedQty;
    const originalQty = Math.max(1, Number(original.qty) || printedQty || 1);
    const cancelledRatio = cancelledQty / originalQty;
    const cancelledSubtotal = round2(Number(original.lineTotal || 0) * cancelledRatio);
    const cancelledTaxAmount = round2(Number(original.taxAmount || 0) * cancelledRatio);
    const cancelledServiceChargeAmount = round2(
      Number(original.serviceChargeAmount || 0) * cancelledRatio,
    );
    return [{
      lineKey,
      menuItem: original.menuItem?._id || original.menuItem || null,
      variationId: original.variation?.id?._id || original.variation?.id || null,
      variationName: original.variation?.name || null,
      name: original.name || 'Unknown item',
      printedQty,
      kitchenSent: requestedQty < printedQty,
      remainingQty: requestedQty,
      cancelledQty,
      unitPrice: Number(original.unitPrice ?? original.listedUnitPrice ?? 0),
      listedUnitPrice: Number(original.listedUnitPrice ?? original.unitPrice ?? 0),
      cancelledSubtotal,
      cancelledTaxAmount,
      cancelledServiceChargeAmount,
      cancelledTotal: round2(
        cancelledSubtotal + cancelledTaxAmount + cancelledServiceChargeAmount,
      ),
    }];
  });
};

export const attachHeldItemCancellationDetails = (cancellations, details, legacyReasons) => (
  cancellations.map((cancellation) => ({
    ...cancellation,
    reason: String(details?.[cancellation.lineKey]?.reason ?? legacyReasons?.[cancellation.lineKey] ?? '').trim(),
    prepared: typeof details?.[cancellation.lineKey]?.prepared === 'boolean'
      ? details[cancellation.lineKey].prepared : null,
  }))
);

export const validateHeldItemCancellations = (cancellations) => {
  const missingReason = cancellations.some((entry) => entry.reason.length < 3);
  const missingPreparation = cancellations.some((entry) => typeof entry.prepared !== 'boolean');
  if (!missingReason && !missingPreparation) return;
  const code = missingReason ? 'HELD_ITEM_CANCEL_REASON_REQUIRED' : 'HELD_ITEM_CANCEL_PREPARATION_REQUIRED';
  throw Object.assign(new Error(missingReason
    ? 'A cancellation reason of at least 3 characters is required for every cancelled saved item.'
    : 'Choose whether every cancelled saved item was already prepared.'), {
    statusCode: 422, code, syncCode: code, details: { cancellations },
  });
};

// Item moves can remove an empty source hold. Keep enough order context on the
// cancellation event for its report row to survive that later operation.
export const cancellationOrderSnapshot = (order) => ({
  _id: order._id,
  outlet: order.outlet,
  cashier: order.cashier,
  transactionNumber: order.transactionNumber,
  createdAt: order.createdAt,
  businessDate: order.businessDate,
  orderType: order.orderType,
  tableNumber: order.tableNumber,
  paymentMethod: order.paymentMethod,
  status: order.status,
});

export default findHeldItemCancellations;
