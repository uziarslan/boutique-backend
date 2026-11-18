import SaleTransaction from '../models/SaleTransaction.js';
import SaleReturn from '../models/SaleReturn.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Shared by live management views and shift close. Match by session, never by
// cashier: an open drawer must remain inspectable after its user is deleted.
export const getSessionTotals = async (sessions) => {
  if (!sessions.length) return new Map();
  const rows = await SaleTransaction.aggregate([
    { $match: { session: { $in: sessions.map((session) => session._id) } } },
    {
      $group: {
        _id: '$session',
        cashSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              '$cashAmount',
              0,
            ],
          },
        },
        cardSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              '$cardAmount',
              0,
            ],
          },
        },
        onlineTransferSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              '$onlineTransferAmount',
              0,
            ],
          },
        },
        storeCreditSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$storeCreditRedeemed', 0] },
              0,
            ],
          },
        },
        foodPandaSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              '$foodPandaAmount',
              0,
            ],
          },
        },
        allowanceSales: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$paymentMethod', 'allowance'] },
                ],
              },
              '$totalAmount',
              0,
            ],
          },
        },
        allowanceOrders: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$paymentMethod', 'allowance'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        chargeToSalarySales: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$paymentMethod', 'charge-to-salary'] },
                ],
              },
              '$totalAmount',
              0,
            ],
          },
        },
        chargeToSalaryOrders: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$paymentMethod', 'charge-to-salary'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        splitBillOrders: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $in: ['$paymentMethod', ['split', 'split-bill']] },
                ],
              },
              1,
              0,
            ],
          },
        },
        totalSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              '$totalAmount',
              0,
            ],
          },
        },
        totalTransactions: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              1,
              0,
            ],
          },
        },
        totalRefunds: {
          $sum: {
            $cond: [{ $eq: ['$isRefund', true] }, '$totalAmount', 0],
          },
        },
        refundedCash: {
          $sum: {
            $cond: [{ $eq: ['$isRefund', true] }, '$cashAmount', 0],
          },
        },
        // ── Membership / Rewards (only completed, non-refund sales) ────────
        pointsRedeemedValue: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$pointsRedeemedValue', 0] },
              0,
            ],
          },
        },
        pointsRedeemed: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$pointsRedeemed', 0] },
              0,
            ],
          },
        },
        pointsEarned: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$pointsEarned', 0] },
              0,
            ],
          },
        },
        rewardsTransactions: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  {
                    $or: [
                      { $gt: [{ $ifNull: ['$pointsRedeemed', 0] }, 0] },
                      { $gt: [{ $ifNull: ['$pointsEarned', 0] }, 0] },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const returns = await SaleReturn.aggregate([
    { $match: { session: { $in: sessions.map((session) => session._id) } } },
    { $group: {
      _id: '$session',
      returnAmount: { $sum: '$refundAmount' },
      cashRefundAmount: { $sum: { $cond: [{ $eq: ['$refundMethod', 'cash'] }, '$refundAmount', 0] } },
    } },
  ]);
  const returnAggregates = new Map(returns.map((row) => [String(row._id), row]));
  const aggregates = new Map(rows.map((row) => {
    const ret = returnAggregates.get(String(row._id));
    return [String(row._id), {
      ...row,
      totalRefunds: round2(Number(row.totalRefunds || 0) + Number(ret?.returnAmount || 0)),
      refundedCash: round2(Number(row.refundedCash || 0) + Number(ret?.cashRefundAmount || 0)),
    }];
  }));
  for (const [id, ret] of returnAggregates) {
    if (!aggregates.has(id)) aggregates.set(id, { totalRefunds: ret.returnAmount, refundedCash: ret.cashRefundAmount });
  }
  return new Map(sessions.map((session) => [
    String(session._id),
    buildSessionTotals(session, aggregates.get(String(session._id))),
  ]));
};

export const buildSessionTotals = (session, agg = {}) => {
  const totalSales = agg.totalSales ?? 0;
  const pointsRedeemedValue = agg.pointsRedeemedValue ?? 0;

  // Always read movements from the shift, including shifts spanning multiple days.
  const movements = session.drawerMovements || [];
  const paidOut = round2(movements.filter((m) => m.type === 'payout').reduce((s, m) => s + (m.amount || 0), 0));
  const paidIn = round2(movements.filter((m) => m.type === 'cash_in').reduce((s, m) => s + (m.amount || 0), 0));

  return {
    cashSales: agg.cashSales ?? 0,
    cardSales: agg.cardSales ?? 0,
    onlineTransferSales: agg.onlineTransferSales ?? 0,
    storeCreditSales: agg.storeCreditSales ?? 0,
    foodPandaSales: agg.foodPandaSales ?? 0,
    allowanceSales: agg.allowanceSales ?? 0,
    allowanceOrders: agg.allowanceOrders ?? 0,
    chargeToSalarySales: agg.chargeToSalarySales ?? 0,
    chargeToSalaryOrders: agg.chargeToSalaryOrders ?? 0,
    splitBillOrders: agg.splitBillOrders ?? 0,
    totalSales,
    totalTransactions: agg.totalTransactions ?? 0,
    totalRefunds: agg.totalRefunds ?? 0,
    netCash: (agg.cashSales ?? 0) - (agg.refundedCash ?? 0),
    pointsRedeemed: agg.pointsRedeemed ?? 0,
    pointsRedeemedValue,
    pointsEarned: agg.pointsEarned ?? 0,
    rewardsTransactions: agg.rewardsTransactions ?? 0,
    grossSales: totalSales + pointsRedeemedValue,
    paidOut,
    paidIn,
  };
};
