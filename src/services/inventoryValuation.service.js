const round4 = (value) => Number((Number(value) || 0).toFixed(4));
const keyOf = (value) => value?.toString?.() ?? String(value ?? '');
const finiteCost = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

export const changesInventoryUnitCost = (movement) => (
  (movement?.type === 'receipt' && movement?.ref?.kind === 'purchase')
  || (movement?.type === 'manual-adjust' && movement?.ref?.kind === 'purchaseAdjustment')
  || movement?.type === 'cost-override'
);

const descendingMovementOrder = (left, right) => {
  // WAC changes when a document is posted, even when its business/effective
  // date (`at`) is backdated. Rewind in posting order to invert the same state
  // transitions that produced Product.currentPrice.
  const byCreated = new Date(right?.createdAt ?? right?.at ?? 0).getTime()
    - new Date(left?.createdAt ?? left?.at ?? 0).getTime();
  if (byCreated !== 0) return byCreated;
  const byAt = new Date(right?.at ?? 0).getTime() - new Date(left?.at ?? 0).getTime();
  if (byAt !== 0) return byAt;
  return keyOf(right?._id).localeCompare(keyOf(left?._id));
};

/**
 * Rewind the tenant-global weighted-average inventory cost from the live
 * Product.currentPrice back to a report cutoff.
 *
 * Stock movement quantities are global here (all outlets and both holding
 * areas) because Product.currentPrice is maintained as one tenant-global WAC.
 * New movements persist inventoryUnitCostBefore/After, which makes the rewind
 * exact. Legacy rows are inverted from their quantity/value change. If a later
 * receipt reset WAC from zero stock, the prior cost is not algebraically
 * recoverable, so the last cost observed at/before the cutoff is used.
 */
export const rewindInventoryUnitCosts = ({
  products = [],
  currentQtyByProduct = new Map(),
  laterMovements = [],
  cutoffCostByProduct = new Map(),
} = {}) => {
  const costs = new Map(
    products.map((product) => [keyOf(product?._id ?? product?.product), Number(product?.currentPrice) || 0]),
  );
  const quantities = new Map(
    [...currentQtyByProduct].map(([product, qty]) => [keyOf(product), Number(qty) || 0]),
  );
  const cutoffCosts = new Map(
    [...cutoffCostByProduct].map(([product, cost]) => [keyOf(product), Number(cost) || 0]),
  );
  // Once a zero-stock reset forces us to use a cutoff observation, that value
  // already represents the requested date. Older post-cutoff cost events must
  // not be inverted on top of it.
  const fixedAtCutoff = new Set();

  const ordered = [...laterMovements].sort(descendingMovementOrder);
  for (const movement of ordered) {
    const product = keyOf(movement?.product);
    if (!product) continue;

    const qty = Number(movement?.qty) || 0;
    const qtyAfter = quantities.get(product) || 0;
    const qtyBefore = qtyAfter - qty;

    if (changesInventoryUnitCost(movement) && !fixedAtCutoff.has(product)) {
      if (finiteCost(movement.inventoryUnitCostBefore)) {
        costs.set(product, round4(movement.inventoryUnitCostBefore));
      } else {
        const currentCost = costs.get(product) || 0;
        const valueChange = Number(movement?.value) || 0;
        const basisQtyBefore = movement.type === 'receipt'
          ? Math.max(0, qtyBefore)
          : qtyBefore;
        const basisQtyAfter = basisQtyBefore + qty;

        if (Math.abs(basisQtyBefore) > 0.000001 && basisQtyAfter > 0) {
          const priorCost = ((currentCost * basisQtyAfter) - valueChange) / basisQtyBefore;
          if (finiteCost(priorCost)) costs.set(product, round4(priorCost));
        } else if (cutoffCosts.has(product)) {
          costs.set(product, round4(cutoffCosts.get(product)));
          fixedAtCutoff.add(product);
        }
      }
    }

    quantities.set(product, qtyBefore);
  }

  return costs;
};
