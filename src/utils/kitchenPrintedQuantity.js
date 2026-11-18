const safeQuantity = (value) => {
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
};

const plainQuantityMap = (value) => {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (value && typeof value.toObject === 'function') return value.toObject();
  return value && typeof value === 'object' ? value : {};
};

export const kitchenLineKey = (item = {}) => {
  const menuItemId = item.menuItem?._id || item.menuItem || item.menuItemId || item.id || item._id || '';
  const variationId = item.variation?.id?._id
    || item.variation?.id
    || item.variationId
    || '';
  const selectionSignature = (item.dealSelections || [])
    .map((selection) => `${String(selection.groupId)}:${(selection.optionIds || []).map(String).sort().join(',')}`)
    .sort()
    .join('|');
  const base = `${String(menuItemId)}::${String(variationId)}`;
  return selectionSignature ? `${base}::${selectionSignature}` : base;
};

export const buildItemQuantityMap = (items = []) => (
  (items || []).reduce((quantities, item) => {
    const key = kitchenLineKey(item);
    if (!key.startsWith('::')) {
      quantities[key] = safeQuantity(quantities[key]) + safeQuantity(item?.qty);
    }
    return quantities;
  }, {})
);

// Convert a persisted printed baseline into a plain, current-order-safe object.
// Old orders can have a print timestamp but no quantity map; in that legacy case
// every quantity that existed at the time is treated as already printed.
export const normalizePrintedQuantityMap = (
  items,
  printedQuantityMap,
  { assumeAllPrinted = false } = {},
) => {
  const currentQuantities = buildItemQuantityMap(items);
  const requested = plainQuantityMap(printedQuantityMap);
  // Key presence matters even when its value is zero. It distinguishes a
  // modern, explicitly-unprinted remainder from a legacy timestamp-only order
  // whose empty map means "all current lines were printed".
  const hasRecordedBaseline = Object.keys(requested).length > 0;
  const baseline = assumeAllPrinted && !hasRecordedBaseline ? currentQuantities : requested;

  return Object.fromEntries(
    Object.entries(currentQuantities)
      .map(([key, currentQuantity]) => [
        key,
        Math.min(safeQuantity(currentQuantity), safeQuantity(baseline[key])),
      ])
      .filter(([, printedQuantity]) => printedQuantity > 0 || hasRecordedBaseline),
  );
};

export const getKitchenDeltaItems = (items = [], printedQuantityMap = {}) => {
  const currentQuantities = buildItemQuantityMap(items);
  const printed = plainQuantityMap(printedQuantityMap);
  const emitted = new Set();

  return (items || []).reduce((delta, item) => {
    const key = kitchenLineKey(item);
    if (emitted.has(key)) return delta;
    emitted.add(key);
    const pendingQuantity = Math.max(
      0,
      safeQuantity(currentQuantities[key]) - safeQuantity(printed[key]),
    );
    if (pendingQuantity <= 0) return delta;
    const plainItem = typeof item?.toObject === 'function' ? item.toObject() : { ...item };
    return [...delta, { ...plainItem, qty: pendingQuantity }];
  }, []);
};

// A move changes which held order owns the units; it does not make the kitchen
// forget units it already received. Printed units are transferred first, up to
// the quantity being moved, while any remaining moved units stay pending.
export const transferPrintedQuantity = ({
  sourceBaseline = {},
  targetBaseline = {},
  nextSourceItems = [],
  nextTargetItems = [],
  lineKey,
  movedQuantity,
}) => {
  const source = { ...plainQuantityMap(sourceBaseline) };
  const target = { ...plainQuantityMap(targetBaseline) };
  const printedQuantityTransferred = Math.min(
    safeQuantity(movedQuantity),
    safeQuantity(source[lineKey]),
  );

  source[lineKey] = Math.max(0, safeQuantity(source[lineKey]) - printedQuantityTransferred);
  target[lineKey] = safeQuantity(target[lineKey]) + printedQuantityTransferred;

  return {
    sourcePrintedQuantityMap: normalizePrintedQuantityMap(nextSourceItems, source),
    targetPrintedQuantityMap: normalizePrintedQuantityMap(nextTargetItems, target),
    printedQuantityTransferred,
  };
};
