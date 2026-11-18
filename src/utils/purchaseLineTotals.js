export const calculatePurchaseLineTotal = (line = {}) => {
  const gross = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
  const discount = Math.min(gross, Math.max(0, Number(line.lineDiscount) || 0));
  return Number((gross - discount).toFixed(2));
};

