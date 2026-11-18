const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const enforceManualDiscountLimit = ({
  cashier,
  subtotal,
  itemDiscounts = 0,
  orderDiscount = 0,
  skip = false,
}) => {
  if (skip) return;

  const manualDiscount = round2(
    Math.max(0, Number(itemDiscounts) || 0) + Math.max(0, Number(orderDiscount) || 0)
  );
  if (manualDiscount <= 0) return;

  const canDiscount = typeof cashier?.hasPermission === 'function'
    ? cashier.hasPermission('pos.discount')
    : cashier?.role === 'owner' || cashier?.permissions?.['pos.discount'] === true;
  if (!canDiscount) {
    throw Object.assign(new Error('You do not have permission to apply discounts.'), { statusCode: 403 });
  }

  const configured = Number(cashier?.posDiscountLimitPercent);
  const limitPercent = Math.min(100, Math.max(0, Number.isFinite(configured) ? configured : 100));
  const maxDiscount = round2(Math.max(0, Number(subtotal) || 0) * (limitPercent / 100));

  if (manualDiscount > maxDiscount + 0.009) {
    throw Object.assign(
      new Error(`Discount exceeds this user's ${limitPercent}% limit (maximum PKR ${maxDiscount.toFixed(2)}).`),
      { statusCode: 422 }
    );
  }
};
