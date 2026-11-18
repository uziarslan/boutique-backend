import { getBusinessDate } from '../utils/businessDate.js';

export const riderBusinessDateForOutlet = (outlet, instant = new Date()) => {
  const start = outlet?.businessDayStart || '00:00';
  return getBusinessDate(
    instant,
    outlet?.timezone || 'Asia/Karachi',
    start,
    outlet?.businessDayEnd || start,
  );
};

export const riderOrdersFilter = ({ riderId, history, businessDate, currentSaleIds = [] }) => ({
  rider: riderId,
  ...(history
    ? {
        // A delivery still in progress remains actionable even if an outlet
        // rolls into a new business day. Completed history is day-scoped.
        $or: [
          { active: true },
          { businessDate },
          { saleTransaction: { $in: currentSaleIds } },
        ],
      }
    : { active: true }),
});

