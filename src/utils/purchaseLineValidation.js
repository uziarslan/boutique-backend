export const purchaseLineTreatment = (purchaseType, line) => {
  if (purchaseType === 'stock') return 'inventory';
  if (purchaseType === 'expense') return 'expense';
  return ['inventory', 'expense', 'asset'].includes(line.accountingTreatment)
    ? line.accountingTreatment
    : 'expense';
};

const invalidPurchaseLine = (message) => {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
};

export const validatePurchaseLineInputs = (lines = [], purchaseType = 'stock') => {
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const qty = Number(line.qty ?? line.quantity);
    const unitPrice = Number(line.unitPrice);
    const lineDiscount = Number(line.lineDiscount || 0);
    const treatment = purchaseLineTreatment(purchaseType, line);

    if (!Number.isFinite(qty) || qty <= 0) {
      throw invalidPurchaseLine(`Quantity must be greater than zero on purchase line ${lineNumber}.`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw invalidPurchaseLine(`Price must be zero or greater on purchase line ${lineNumber}.`);
    }
    if (!Number.isFinite(lineDiscount) || lineDiscount < 0) {
      throw invalidPurchaseLine(`Discount must be zero or greater on purchase line ${lineNumber}.`);
    }
    if (lineDiscount - (qty * unitPrice) > 0.005) {
      throw invalidPurchaseLine(`Discount cannot exceed the gross amount on purchase line ${lineNumber}.`);
    }
    if (treatment === 'inventory' && line.entryMode === 'pack') {
      const packSize = Number(line.packSize);
      if (!Number.isFinite(packSize) || packSize <= 1) {
        throw invalidPurchaseLine(`Units per pack must be greater than 1 on purchase line ${lineNumber}.`);
      }
    }
    if (
      line.priceEntryMode !== undefined
      && !['unit', 'total'].includes(line.priceEntryMode)
    ) {
      throw invalidPurchaseLine(`Price entry method is invalid on purchase line ${lineNumber}.`);
    }
  });
};

