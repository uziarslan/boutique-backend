const cleanNumber = (value) => {
  const n = Number(value) || 0;
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
};

const lineName = (line) =>
  line?.product?.name
  || line?.productName
  || line?.description
  || 'Item';

export const summarizePurchaseItems = (lines = [], limit = 2) => {
  const meaningful = (Array.isArray(lines) ? lines : []).filter(
    (line) => Number(line?.qty ?? line?.quantity ?? line?.receivedQty) > 0,
  );
  if (!meaningful.length) return 'Purchase';

  const shown = meaningful.slice(0, limit).map((line) => {
    const qty = Number(line.qty ?? line.quantity ?? line.receivedQty) || 0;
    const packSize = Math.max(1, Number(line.packSize) || 1);
    const unit = line.unit || line?.product?.unit || '';
    if (packSize > 1) {
      return `${lineName(line)} ${cleanNumber(qty)} × ${cleanNumber(packSize)}${unit ? ` ${unit}` : ''}`;
    }
    return `${lineName(line)} ${cleanNumber(qty)}${unit ? ` ${unit}` : ''}`;
  });

  const remaining = meaningful.length - shown.length;
  return `${shown.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''}`;
};

export const paymentItemSummary = (purchase) =>
  `Payment: ${purchase?.itemSummary || summarizePurchaseItems(purchase?.lines)}`;

