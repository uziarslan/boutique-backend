import { businessDateRange, getBusinessDate, normalizeBusinessDayStart } from './businessDate.js';
import { localDateRange } from './timezone.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Both item audits and whole-order voids belong to the cancellation's business
// date. Legacy events have only a timestamp; apply the same rollover as
// getBusinessDate rather than excluding the after-midnight part of a shift.
export const cancellationReportDateMatch = ({ dateField, timestampField, from, to, clock, now = new Date() }) => {
  const timezone = clock.timezone;
  const today = !from && !to
    ? getBusinessDate(now, timezone, clock.businessDayStart, clock.businessDayEnd) : null;
  const range = businessDateRange(from || today, to || today);
  const minutes = (time) => {
    const [hours, mins] = normalizeBusinessDayStart(time).split(':').map(Number);
    return hours * 60 + mins;
  };
  const start = minutes(clock.businessDayStart);
  const end = minutes(clock.businessDayEnd ?? clock.businessDayStart);
  const rollover = start === end ? start : start > end ? end : 0;
  const timestamp = `$${timestampField}`;
  const legacyBusinessDate = {
    $let: {
      vars: { local: { $dateToParts: { date: timestamp, timezone } } },
      in: { $dateToString: {
        format: '%Y-%m-%d', timezone,
        date: { $cond: [
          { $lt: [{ $add: [{ $multiply: ['$$local.hour', 60] }, '$$local.minute'] }, rollover] },
          { $dateSubtract: { startDate: timestamp, unit: 'day', amount: 1, timezone } },
          timestamp,
        ] },
      } },
    },
  };
  // Keep an indexable, inclusive timestamp bound before evaluating old rows.
  // Their calendar date can be either the business date or the following day.
  const lastDate = range.$lte ? new Date(`${range.$lte}T00:00:00Z`) : null;
  if (lastDate) lastDate.setUTCDate(lastDate.getUTCDate() + 1);
  const legacyRange = localDateRange(range.$gte, lastDate?.toISOString().slice(0, 10), timezone);
  return { $or: [
    { [dateField]: range },
    {
      [dateField]: { $in: [null, ''] },
      [timestampField]: legacyRange,
      $expr: { $and: Object.entries(range).map(([operator, date]) => ({ [operator]: [legacyBusinessDate, date] })) },
    },
  ] };
};

const cancellationItemValue = (cancellation) => {
  const recorded = Number(cancellation?.cancelledTotal);
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  return money(
    Number(cancellation?.listedUnitPrice ?? cancellation?.unitPrice ?? 0)
      * Number(cancellation?.cancelledQty || 0),
  );
};

// Whole-order cancellation can select only some quantities as prepared waste.
// Retain that distinction in the report instead of labelling every item made.
export const withOrderPreparationDetails = (order) => {
  const hasPreparedSelection = order.wasPreparedAtCancellation === true
    && (order.items || []).some((item) => Number(item.wastedQty) > 0);
  const items = (order.items || []).map((item) => {
    const preparedQty = hasPreparedSelection ? Math.min(Number(item.qty), Number(item.wastedQty) || 0) : null;
    return {
      ...item,
      preparedQty,
      wasPreparedAtCancellation: preparedQty === null ? order.wasPreparedAtCancellation
        : preparedQty === 0 ? false : preparedQty === Number(item.qty) ? true : null,
      preparationStatus: preparedQty > 0 && preparedQty < Number(item.qty) ? 'mixed' : null,
    };
  });
  const mixed = hasPreparedSelection && items.some((item) => item.preparedQty < Number(item.qty));
  return { ...order, items, preparationStatus: mixed ? 'mixed' : null };
};

// Convert the durable audit event created by held-item cancellation into the
// same report-row contract used by whole-order voids. This also makes item
// cancellations recorded before this report existed visible retroactively.
export const itemCancellationAuditToReportRow = (event, clock) => {
  const order = event?.order || {};
  const cancellations = Array.isArray(event?.after?.cancellations)
    ? event.after.cancellations
    : [];
  const originalTotalAmount = money(event?.before?.totalAmount);
  const remainingTotalAmount = money(event?.after?.totalAmount);
  const itemValue = money(cancellations.reduce(
    (sum, cancellation) => sum + cancellationItemValue(cancellation),
    0,
  ));
  const reasons = [...new Set(
    cancellations.map((cancellation) => String(cancellation?.reason || '').trim()).filter(Boolean),
  )];

  return {
    _id: `item-cancellation:${String(event?._id || '')}`,
    cancellationType: 'items',
    transactionId: order._id || event?.recordId || null,
    transactionNumber: event?.after?.transactionNumber || order.transactionNumber || '',
    createdAt: order.createdAt || null,
    businessDate: order.businessDate || null,
    voidedAt: event?.timestamp || null,
    voidBusinessDate: event?.after?.cancellationBusinessDate || (clock && event?.timestamp
      ? getBusinessDate(new Date(event.timestamp), clock.timezone, clock.businessDayStart, clock.businessDayEnd) : null),
    voidReason: reasons.join('; '),
    voidedByName: event?.actorName || '',
    cashierName: event?.cashierName || '',
    orderType: order.orderType || '',
    tableNumber: order.tableNumber || '',
    paymentMethod: order.paymentMethod || '',
    status: order.status || '',
    wasPreparedAtCancellation: cancellations.length > 0 && cancellations.every((entry) => entry.prepared === true)
      ? true : cancellations.length > 0 && cancellations.every((entry) => entry.prepared === false) ? false : null,
    preparationStatus: cancellations.some((entry) => typeof entry.prepared !== 'boolean')
      ? 'not-recorded' : new Set(cancellations.map((entry) => entry.prepared)).size > 1 ? 'mixed' : null,
    totalAmount: itemValue,
    originalTotalAmount,
    remainingTotalAmount,
    itemCount: cancellations.reduce(
      (sum, cancellation) => sum + Number(cancellation?.cancelledQty || 0),
      0,
    ),
    items: cancellations.map((cancellation) => {
      const qty = Number(cancellation?.cancelledQty || 0);
      const unitPrice = Number(
        cancellation?.listedUnitPrice ?? cancellation?.unitPrice ?? 0,
      );
      return {
        menuItem: cancellation?.menuItem || null,
        name: cancellation?.name || 'Unknown item',
        variationName: cancellation?.variationName || null,
        qty,
        unitPrice,
        lineTotal: cancellationItemValue(cancellation),
        reason: cancellation?.reason || '',
        wasPreparedAtCancellation: typeof cancellation?.prepared === 'boolean' ? cancellation.prepared : null,
      };
    }),
    praStatus: null,
    praInvoiceNumber: null,
    praCreditStatus: null,
    praCreditInvoiceNumber: null,
  };
};

export default itemCancellationAuditToReportRow;
