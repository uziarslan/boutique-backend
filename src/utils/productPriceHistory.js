const legacyGrnIdFor = (row) => row?.grn || row?._doc?.grn || null;

const normalizeHistory = (history = []) => {
  let changed = 0;
  for (const row of history || []) {
    if (row?.source !== 'grn') continue;
    const legacyGrnId = legacyGrnIdFor(row);
    row.source = 'purchase';
    if (legacyGrnId && !row.legacyGrnId) row.legacyGrnId = legacyGrnId;
    if (row.grn !== undefined) delete row.grn;
    if (row._doc?.grn !== undefined) delete row._doc.grn;
    changed += 1;
  }
  return changed;
};

export const normalizeLegacyProductPriceHistory = (product) => {
  if (!product) return 0;
  let changed = normalizeHistory(product.priceHistory);
  for (const vendor of product.vendors || []) {
    changed += normalizeHistory(vendor.priceHistory);
  }
  return changed;
};

