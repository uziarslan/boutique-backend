import mongoose from 'mongoose';
import SaleSession from '../models/SaleSession.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SaleReturn from '../models/SaleReturn.js';
import Outlet from '../models/Outlet.js';
import AuditLog from '../models/AuditLog.js';
import Employee from '../models/Employee.js';
import SalaryAdvance from '../models/SalaryAdvance.js';
import { postSalaryAdvance, reverseJournalEntry } from '../accounting/journalEngine.js';
import {
  authorizeEmployeeCredit,
  withEmployeeCreditLock,
} from '../services/employeeCredit.service.js';
import logger from '../utils/logger.js';
import { getSessionTotals } from '../services/sessionTotals.service.js';
import { resolveTimezone, startOfLocalDayUtc, endOfLocalDayUtc } from '../utils/timezone.js';
import { getBusinessDate } from '../utils/businessDate.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── openSession ────────────────────────────────────────────────────────────────
// POST /api/pos/sessions/open
// Body: { openingFloat? }
// Auth: cashier JWT — outlet derived from req.user.outletRef (set by auth.middleware)

export const openSession = async (req, res) => {
  const { openingFloat = 0, outletId: bodyOutletId, outletCode: bodyOutletCode } = req.body;

  // Resolve which outlet's till is being opened.
  let outletId;

  if (req.user.role === 'cashier') {
    // Cashiers are locked to the outlet assigned to their account by auth
    // middleware. The request body is ignored so a cashier can't open a till
    // for another outlet.
    outletId = req.user.outletRef;
    if (!outletId) {
      return res.status(422).json({
        success: false,
        message: 'Cashier account has no outlet assigned. Contact an owner to fix this.',
      });
    }
  } else {
    // Owners / managers aren't tied to a single outlet, so they pick one. Honour
    // an explicit selection from the request; otherwise fall back to the only
    // active outlet when there's just one.
    let outlet = null;
    if (bodyOutletId && mongoose.isValidObjectId(bodyOutletId)) {
      outlet = await Outlet.findOne({ _id: bodyOutletId, isActive: true }).lean();
    } else if (bodyOutletCode) {
      outlet = await Outlet.findOne({ code: String(bodyOutletCode).toUpperCase(), isActive: true }).lean();
    }

    if (!outlet) {
      const activeOutlets = await Outlet.find({ isActive: true }).select('_id').limit(2).lean();
      if (activeOutlets.length === 1) {
        outlet = activeOutlets[0];
      } else if (activeOutlets.length === 0) {
        return res.status(422).json({
          success: false,
          message: 'No active outlet found. Create an outlet in Settings before opening a shift.',
        });
      } else {
        return res.status(422).json({
          success: false,
          message: 'Select an outlet to open a shift for.',
        });
      }
    }

    outletId = outlet._id;
  }

  // Business rule: only one open session per cashier+outlet at a time
  const existing = await SaleSession.findOne({
    cashier: req.user.id,
    outlet: outletId,
    status: 'open',
  }).lean();

  if (existing) {
    return res.status(409).json({
      success: false,
      message: `Session ${existing.sessionNumber} is already open. Close it before starting a new one.`,
      data: { sessionNumber: existing.sessionNumber, openedAt: existing.openedAt },
    });
  }

  const session = await SaleSession.create({
    outlet: outletId,
    cashier: req.user.id,
    cashierName: req.user.name,
    openingFloat: Number(openingFloat),
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_session_opened',
    module: 'posSession',
    recordId: session._id,
    after: { sessionNumber: session.sessionNumber, outlet: outletId, openingFloat },
    ip: req.ip,
  });

  logger.info(`POS session opened: ${session.sessionNumber} by ${req.user.email}`);

  const populated = await SaleSession.findById(session._id)
    .populate('outlet', 'name code timezone')
    .populate('cashier', 'name email')
    .lean();

  return res.status(201).json({ success: true, data: populated });
};

// ── closeSession ───────────────────────────────────────────────────────────────
// POST /api/pos/sessions/close
// Body: { closingFloat, notes? }
// Auth: cashier JWT

export const closeSession = async (req, res) => {
  const { closingFloat, notes } = req.body;

  if (closingFloat == null || isNaN(Number(closingFloat))) {
    return res.status(422).json({ success: false, message: 'closingFloat is required.' });
  }

  const session = await SaleSession.findOne({
    cashier: req.user.id,
    status: 'open',
  });

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'No open session found for this cashier.',
    });
  }

  const totalsBySession = await getSessionTotals([session]);
  const totals = totalsBySession.get(String(session._id));

  // ── Write final state ─────────────────────────────────────────────────────
  session.status = 'closed';
  session.closedAt = new Date();
  session.closingFloat = Number(closingFloat);
  session.totals = totals;
  if (notes) session.notes = notes;

  await session.save();

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_session_closed',
    module: 'posSession',
    recordId: session._id,
    after: {
      sessionNumber: session.sessionNumber,
      closingFloat: session.closingFloat,
      totals,
    },
    ip: req.ip,
  });

  logger.info(
    `POS session closed: ${session.sessionNumber} | ` +
    `sales=${totals.totalSales.toFixed(2)} | txns=${totals.totalTransactions} | ` +
    `by ${req.user.email}`
  );

  const populated = await SaleSession.findById(session._id)
    .populate('outlet', 'name code timezone')
    .populate('cashier', 'name email')
    .lean();

  return res.json({ success: true, data: populated });
};

// ── getCurrentSessionSummary ───────────────────────────────────────────────────
// GET /api/pos/sessions/current/summary
// Auth: cashier JWT
// Returns live totals for the open session, restricted to the outlet's CURRENT
// business day. A session can accidentally remain open across midnight/day-end;
// those older sales must not leak into today's End of Day report.

export const getCurrentSessionSummary = async (req, res) => {
  const session = await SaleSession.findOne({
    cashier: req.user.id,
    status: 'open',
  }).lean();

  if (!session) {
    return res.status(404).json({ success: false, message: 'No open session found.' });
  }

  const outletClock = await Outlet.findById(session.outlet)
    .select('timezone businessDayStart businessDayEnd')
    .lean();
  const timezone = outletClock?.timezone || 'Asia/Karachi';
  const businessDayStart = outletClock?.businessDayStart || '00:00';
  const businessDayEnd = outletClock?.businessDayEnd || businessDayStart;
  const currentBusinessDate = getBusinessDate(
    new Date(),
    timezone,
    businessDayStart,
    businessDayEnd,
  );

  // Legacy transactions predate the immutable businessDate field. Interpret
  // their createdAt using the same outlet-local business-day boundary.
  const [startHour, startMinute] = businessDayStart.split(':').map(Number);
  const legacyStart = startOfLocalDayUtc(currentBusinessDate, timezone);
  legacyStart.setUTCMinutes(legacyStart.getUTCMinutes() + (startHour * 60) + startMinute);
  const nextCalendarDate = new Date(`${currentBusinessDate}T00:00:00.000Z`);
  nextCalendarDate.setUTCDate(nextCalendarDate.getUTCDate() + 1);
  const nextStart = startOfLocalDayUtc(nextCalendarDate.toISOString().slice(0, 10), timezone);
  nextStart.setUTCMinutes(nextStart.getUTCMinutes() + (startHour * 60) + startMinute);
  const legacyEnd = new Date(nextStart.getTime() - 1);

  const businessDayMatch = {
    session: session._id,
    $or: [
      { businessDate: currentBusinessDate },
      { businessDate: null, createdAt: { $gte: legacyStart, $lte: legacyEnd } },
    ],
  };

  const [[agg = {}], [drawerAgg = {}], [returnAgg = {}]] = await Promise.all([
    SaleTransaction.aggregate([
    { $match: businessDayMatch },
    {
      $group: {
        _id: null,
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
              { $and: [
                { $eq: ['$isRefund', false] },
                { $eq: ['$status', 'completed'] },
                { $eq: ['$paymentMethod', 'allowance'] },
              ] },
              '$totalAmount',
              0,
            ],
          },
        },
        allowanceOrders: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$isRefund', false] },
                { $eq: ['$status', 'completed'] },
                { $eq: ['$paymentMethod', 'allowance'] },
              ] },
              1,
              0,
            ],
          },
        },
        chargeToSalarySales: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$isRefund', false] },
                { $eq: ['$status', 'completed'] },
                { $eq: ['$paymentMethod', 'charge-to-salary'] },
              ] },
              '$totalAmount',
              0,
            ],
          },
        },
        chargeToSalaryOrders: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$isRefund', false] },
                { $eq: ['$status', 'completed'] },
                { $eq: ['$paymentMethod', 'charge-to-salary'] },
              ] },
              1,
              0,
            ],
          },
        },
        splitBillOrders: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$isRefund', false] },
                { $eq: ['$status', 'completed'] },
                { $in: ['$paymentMethod', ['split', 'split-bill']] },
              ] },
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
        totalOrders: { $sum: 1 },
        grossSales: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              {
                $cond: [
                  { $gt: [{ $ifNull: ['$subtotal', 0] }, 0] },
                  { $ifNull: ['$subtotal', 0] },
                  {
                    $max: [0, {
                      $add: [
                        {
                          $subtract: [
                            { $ifNull: ['$totalAmount', 0] },
                            {
                              $add: [
                                { $ifNull: ['$taxAmount', 0] },
                                { $ifNull: ['$serviceChargeAmount', 0] },
                                { $ifNull: ['$deliveryChargeAmount', 0] },
                              ],
                            },
                          ],
                        },
                        { $ifNull: ['$discountAmount', 0] },
                        { $ifNull: ['$pointsRedeemedValue', 0] },
                      ],
                    }],
                  },
                ],
              },
              0,
            ],
          },
        },
        serviceCharge: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$serviceChargeAmount', 0] },
              0,
            ],
          },
        },
        salesTax: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$taxAmount', 0] },
              0,
            ],
          },
        },
        deliveryCharge: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $ifNull: ['$deliveryChargeAmount', 0] },
              0,
            ],
          },
        },
        discount: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $add: [{ $ifNull: ['$discountAmount', 0] }, { $ifNull: ['$pointsRedeemedValue', 0] }] },
              0,
            ],
          },
        },
        salesExcludingServiceCharges: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
              { $max: [0, { $subtract: [{ $ifNull: ['$totalAmount', 0] }, { $ifNull: ['$serviceChargeAmount', 0] }] }] },
              0,
            ],
          },
        },
        foodPandaOrders: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$isRefund', false] },
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$paymentMethod', 'foodpanda'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        heldOrdersTotal: {
          $sum: {
            $cond: [
              { $in: ['$status', ['held', 'out-for-delivery']] },
              { $ifNull: ['$totalAmount', 0] },
              0,
            ],
          },
        },
        heldOrdersCount: {
          $sum: { $cond: [{ $in: ['$status', ['held', 'out-for-delivery']] }, 1, 0] },
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
    ]),
    // Drawer reconciliation remains session-wide: the physical till still
    // contains prior-day cash when a cashier forgot to close the session.
    SaleTransaction.aggregate([
      { $match: { session: session._id } },
      {
        $group: {
          _id: null,
          cashSales: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$isRefund', false] }, { $eq: ['$status', 'completed'] }] },
                '$cashAmount',
                0,
              ],
            },
          },
          refundedCash: {
            $sum: {
              $cond: [{ $eq: ['$isRefund', true] }, '$cashAmount', 0],
            },
          },
        },
      },
    ]),
    SaleReturn.aggregate([
      { $match: { session: session._id, createdAt: { $gte: legacyStart, $lte: legacyEnd } } },
      { $group: {
        _id: null,
        totalRefunds: { $sum: '$refundAmount' },
        cashRefunds: { $sum: { $cond: [{ $eq: ['$refundMethod', 'cash'] }, '$refundAmount', 0] } },
      } },
    ]),
  ]);

  const totalSales = agg.totalSales ?? 0;
  const pointsRedeemedValue = agg.pointsRedeemedValue ?? 0;

  // Petty-cash drawer movements recorded during the shift.
  const movements = session.drawerMovements || [];
  const paidOut = round2(movements.filter((m) => m.type === 'payout').reduce((s, m) => s + (m.amount || 0), 0));
  const paidIn = round2(movements.filter((m) => m.type === 'cash_in').reduce((s, m) => s + (m.amount || 0), 0));

  return res.json({
    success: true,
    data: {
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
      grossSales: agg.grossSales ?? 0,
      serviceCharge: agg.serviceCharge ?? 0,
      salesTax: agg.salesTax ?? 0,
      deliveryCharge: agg.deliveryCharge ?? 0,
      discount: agg.discount ?? 0,
      netSales: totalSales,
      salesExcludingServiceCharges: agg.salesExcludingServiceCharges ?? 0,
      averageOrderValue: (agg.totalTransactions ?? 0) > 0 ? totalSales / agg.totalTransactions : 0,
      totalTransactions: agg.totalTransactions ?? 0,
      invoices: agg.totalTransactions ?? 0,
      totalOrders: agg.totalOrders ?? 0,
      foodPandaOrders: agg.foodPandaOrders ?? 0,
      heldOrdersTotal: agg.heldOrdersTotal ?? 0,
      heldOrdersCount: agg.heldOrdersCount ?? 0,
      totalRefunds: (agg.totalRefunds ?? 0) + (returnAgg.totalRefunds ?? 0),
      netCash: (agg.cashSales ?? 0) - (agg.refundedCash ?? 0) - (returnAgg.cashRefunds ?? 0),
      drawerNetCash: (drawerAgg.cashSales ?? 0) - (drawerAgg.refundedCash ?? 0) - (returnAgg.cashRefunds ?? 0),
      businessDate: currentBusinessDate,
      businessDayStart,
      businessDayEnd,
      // Cash drawer petty-cash movements.
      paidOut,
      paidIn,
      drawerMovements: movements,
      // Rewards block — all defaulted to 0 when the feature was off all shift.
      pointsRedeemed: agg.pointsRedeemed ?? 0,
      pointsRedeemedValue,
      pointsEarned: agg.pointsEarned ?? 0,
      rewardsTransactions: agg.rewardsTransactions ?? 0,
    },
  });
};

// ── getCurrentSession ──────────────────────────────────────────────────────────
// GET /api/pos/sessions/current
// Auth: cashier JWT
// Returns the open session for the requesting cashier, or null if none.
// The POS frontend shows the "Open Session" screen when this returns null.

export const getCurrentSession = async (req, res) => {
  const session = await SaleSession.findOne({
    cashier: req.user.id,
    status: 'open',
  })
    .populate('outlet', 'name code timezone')
    .populate('cashier', 'name email')
    .lean();

  return res.json({ success: true, data: session ?? null });
};

// ── recordDrawerMovement ────────────────────────────────────────────────────────
// POST /api/pos/sessions/drawer-movement
// Body: { type: 'payout' | 'cash_in', amount, reason? }
// Auth: cashier JWT (acts on the caller's own open session)
//
// Operational cash-count aid only: movements change the expected physical
// drawer amount for this shift. They never post or reverse accounting entries.

export const recordDrawerMovement = async (req, res) => {
  const { type, amount, reason } = req.body;

  if (!['payout', 'cash_in'].includes(type)) {
    return res.status(422).json({ success: false, message: "type must be 'payout' or 'cash_in'." });
  }
  const amt = round2(amount);
  if (!amt || amt <= 0 || Number.isNaN(amt)) {
    return res.status(422).json({ success: false, message: 'A positive amount is required.' });
  }

  const session = await SaleSession.findOne({ cashier: req.user.id, status: 'open' });
  if (!session) {
    return res.status(409).json({ success: false, message: 'No open session. Open a shift first.' });
  }

  const movement = {
    type,
    amount: amt,
    reason: reason?.trim() || undefined,
    by: req.user.id,
    at: new Date(),
  };

  session.drawerMovements.push(movement);
  await session.save();

  await AuditLog.create({
    user: req.user.id,
    action: type === 'payout' ? 'pos_drawer_payout' : 'pos_drawer_cash_in',
    module: 'pos',
    recordId: session._id,
    after: { type, amount: amt, reason: movement.reason },
    ip: req.ip,
  });

  logger.info(`Drawer ${type}: ${amt} on session ${session.sessionNumber} by ${req.user.email}`);

  const movements = session.drawerMovements;
  const paidOut = round2(movements.filter((m) => m.type === 'payout').reduce((s, m) => s + (m.amount || 0), 0));
  const paidIn = round2(movements.filter((m) => m.type === 'cash_in').reduce((s, m) => s + (m.amount || 0), 0));

  return res.status(201).json({
    success: true,
    data: {
      movement: movements[movements.length - 1],
      paidOut,
      paidIn,
      drawerMovements: movements,
    },
  });
};

const drawerMovementPayload = (session) => {
  const movements = session.drawerMovements;
  return {
    paidOut: round2(movements.filter((m) => m.type === 'payout').reduce((s, m) => s + (m.amount || 0), 0)),
    paidIn: round2(movements.filter((m) => m.type === 'cash_in').reduce((s, m) => s + (m.amount || 0), 0)),
    drawerMovements: movements,
  };
};

// POST /api/pos/sessions/employee-advance
// Body: { employeeId, amount, notes?, creditLimitOverride? }
//
// This is one coordinated operation: the employee receivable and accounting
// entry are created first, then the same cash is removed from the caller's
// open till. If the drawer update fails, the accounting work is compensated.
export const issueEmployeeAdvanceFromDrawer = async (req, res) => {
  const { employeeId, notes } = req.body || {};
  const requestedAmount = Number(req.body?.amount);
  const amount = round2(requestedAmount);
  const overrideRequested = req.body?.creditLimitOverride?.requested === true;
  const overrideReason = req.body?.creditLimitOverride?.reason || '';

  if (!mongoose.isValidObjectId(employeeId)) {
    return res.status(400).json({ success: false, message: 'Select a valid employee.' });
  }
  if (!Number.isFinite(requestedAmount) || !amount || amount < 1) {
    return res.status(400).json({ success: false, message: 'Enter a valid advance amount (at least 1).' });
  }

  const session = await SaleSession.findOne({ cashier: req.user.id, status: 'open' });
  if (!session) {
    return res.status(409).json({ success: false, message: 'No open session. Open a shift first.' });
  }

  const outletClock = await Outlet.findById(session.outlet)
    .select('timezone businessDayStart businessDayEnd')
    .lean();
  if (!outletClock) {
    return res.status(409).json({ success: false, message: 'The session outlet could not be resolved.' });
  }
  const timezone = outletClock.timezone || 'Asia/Karachi';
  const businessDayStart = outletClock.businessDayStart || '00:00';
  const businessDayEnd = outletClock.businessDayEnd || businessDayStart;
  const businessDate = getBusinessDate(new Date(), timezone, businessDayStart, businessDayEnd);
  const businessDateInstant = startOfLocalDayUtc(businessDate, timezone);

  const employee = await Employee.findById(employeeId);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
  if (!employee.isActive) {
    return res.status(422).json({ success: false, message: 'Credit cannot be issued to an inactive employee.' });
  }

  try {
    const result = await withEmployeeCreditLock(employee._id, async () => {
      const currentEmployee = await Employee.findById(employee._id);
      if (!currentEmployee || !currentEmployee.isActive) {
        const error = new Error('The employee is no longer active.');
        error.statusCode = 422;
        throw error;
      }

      const decision = await authorizeEmployeeCredit({
        employee: currentEmployee,
        amount,
        type: 'cash',
        actor: req.user,
        overrideRequested,
        overrideReason,
      });

      let advance = null;
      let journalEntry = null;
      try {
        advance = await SalaryAdvance.create({
          employee: currentEmployee._id,
          type: 'cash',
          amount,
          businessDate,
          advanceDate: businessDateInstant,
          paymentMode: 'cash',
          transactionRef: `POS Drawer · ${session.sessionNumber}`,
          notes: String(notes || '').trim() || undefined,
          creditPolicySnapshot: decision.snapshot,
          createdBy: req.user.id,
        });

        journalEntry = await postSalaryAdvance(
          advance,
          currentEmployee.name,
          req.user.id
        );
        advance.journalEntryId = journalEntry._id;
        await advance.save();

        const movementReason = [
          `Salary advance — ${currentEmployee.name}`,
          String(notes || '').trim(),
        ].filter(Boolean).join(' · ').slice(0, 300);
        const updatedSession = await SaleSession.findOneAndUpdate(
          { _id: session._id, cashier: req.user.id, status: 'open' },
          {
            $push: {
              drawerMovements: {
                type: 'payout',
                amount,
                reason: movementReason,
                salaryAdvance: advance._id,
                by: req.user.id,
                at: new Date(),
              },
            },
          },
          { returnDocument: 'after', runValidators: true }
        );
        if (!updatedSession) {
          const error = new Error('The POS session closed before the advance was completed. Please try again.');
          error.statusCode = 409;
          throw error;
        }

        return { advance, decision, employee: currentEmployee, session: updatedSession };
      } catch (error) {
        if (journalEntry?._id) {
          try { await reverseJournalEntry(journalEntry._id, req.user.id); } catch (rollbackError) {
            logger.error(`[pos] Failed to reverse advance journal during rollback: ${rollbackError.message}`);
          }
        }
        if (advance?._id) {
          try { await SalaryAdvance.deleteOne({ _id: advance._id }); } catch (rollbackError) {
            logger.error(`[pos] Failed to delete advance during rollback: ${rollbackError.message}`);
          }
        }
        throw error;
      }
    });

    const latestMovement = result.session.drawerMovements[result.session.drawerMovements.length - 1];
    const payload = drawerMovementPayload(result.session);

    try {
      await AuditLog.create({
        user: req.user.id,
        actorName: req.user.name,
        actorRole: req.user.role,
        action: 'pos_employee_advance_issued',
        module: 'pos',
        recordId: result.advance._id,
        after: {
          employeeId: result.employee._id,
          employeeName: result.employee.name,
          amount,
          sessionId: result.session._id,
          sessionNumber: result.session.sessionNumber,
          overrideUsed: result.decision.overrideUsed,
          overriddenLimits: result.decision.overriddenLimits,
          overrideReason: result.decision.overrideReason,
        },
        ip: req.ip,
      });
    } catch (auditError) {
      logger.warn(`[pos] Failed to write employee advance audit: ${auditError.message}`);
    }

    logger.info(`POS employee advance: ${result.employee.name} | amount: ${amount} | session: ${result.session.sessionNumber}`);
    return res.status(201).json({
      success: true,
      data: {
        advance: result.advance,
        movement: latestMovement,
        ...payload,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || 'Failed to issue employee advance.',
      creditSummary: error.summary,
      reasons: error.reasons,
    });
  }
};

// Historical movement documents may retain a legacy journalEntry link. Editing
// or deleting a drawer note intentionally leaves that old accounting entry
// untouched; drawer operations are no longer an accounting source.
export const updateDrawerMovement = async (req, res) => {
  const { type, amount, reason } = req.body;
  if (!['payout', 'cash_in'].includes(type)) {
    return res.status(422).json({ success: false, message: "type must be 'payout' or 'cash_in'." });
  }
  const amt = round2(amount);
  if (!amt || amt <= 0 || Number.isNaN(amt)) {
    return res.status(422).json({ success: false, message: 'A positive amount is required.' });
  }

  const session = await SaleSession.findOne({ cashier: req.user.id, status: 'open' });
  if (!session) return res.status(409).json({ success: false, message: 'No open session. Open a shift first.' });
  const movement = session.drawerMovements.id(req.params.movementId);
  if (!movement) return res.status(404).json({ success: false, message: 'Drawer movement not found.' });
  if (movement.salaryAdvance) {
    return res.status(409).json({
      success: false,
      message: 'Employee advance drawer movements cannot be edited separately from their payroll record.',
    });
  }

  const before = { type: movement.type, amount: movement.amount, reason: movement.reason };
  const replacement = { type, amount: amt, reason: reason?.trim() || undefined, by: req.user.id, at: movement.at };

  movement.type = type;
  movement.amount = amt;
  movement.reason = replacement.reason;
  movement.by = req.user.id;
  await session.save();

  await AuditLog.create({
    user: req.user.id, action: 'pos_drawer_movement_edited', module: 'pos',
    recordId: session._id, before, after: { type, amount: amt, reason: replacement.reason }, ip: req.ip,
  });
  return res.json({ success: true, data: { movement, ...drawerMovementPayload(session) } });
};

export const deleteDrawerMovement = async (req, res) => {
  const session = await SaleSession.findOne({ cashier: req.user.id, status: 'open' });
  if (!session) return res.status(409).json({ success: false, message: 'No open session. Open a shift first.' });
  const movement = session.drawerMovements.id(req.params.movementId);
  if (!movement) return res.status(404).json({ success: false, message: 'Drawer movement not found.' });
  if (movement.salaryAdvance) {
    return res.status(409).json({
      success: false,
      message: 'Employee advance drawer movements cannot be deleted separately from their payroll record.',
    });
  }
  const before = { type: movement.type, amount: movement.amount, reason: movement.reason };
  movement.deleteOne();
  await session.save();
  await AuditLog.create({
    user: req.user.id, action: 'pos_drawer_movement_deleted', module: 'pos',
    recordId: session._id, before, ip: req.ip,
  });
  return res.json({ success: true, data: drawerMovementPayload(session) });
};

// ── getSessionById ─────────────────────────────────────────────────────────────
// GET /api/pos/sessions/:id
// Auth: owner or financeManager
// Returns the full session with its transaction list.

export const getSessionById = async (req, res) => {
  const session = await SaleSession.findById(req.params.id)
    .populate('outlet', 'name code timezone')
    .populate('cashier', 'name email role')
    .populate('drawerMovements.by', 'name email')
    .lean();

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found.' });
  }

  const [transactions, totalsBySession] = await Promise.all([
    SaleTransaction.find({ session: session._id }).sort({ createdAt: 1 }).lean(),
    getSessionTotals(session.status === 'open' ? [session] : []),
  ]);
  if (session.status === 'open') {
    session.totals = totalsBySession.get(String(session._id));
  }

  return res.json({ success: true, data: { ...session, transactions } });
};

// ── getAllSessions ─────────────────────────────────────────────────────────────
// GET /api/pos/sessions
// Query: outlet, cashier, status, dateFrom, dateTo, page, limit
// Auth: owner or financeManager

export const getAllSessions = async (req, res) => {
  const {
    outlet, cashier, status,
    dateFrom, dateTo,
    page = 1, limit = 20,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {};

  if (outlet) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (cashier) filter.cashier = new mongoose.Types.ObjectId(cashier);
  if (status && ['open', 'closed'].includes(status)) filter.status = status;

  if (dateFrom || dateTo) {
    // Interpret the `dateFrom`/`dateTo` calendar days in the outlet's timezone
    // (falling back to the tenant default when no outlet is selected), not the
    // server's UTC day. Stored `openedAt` instants remain UTC.
    const tz = await resolveTimezone(outlet);
    filter.openedAt = {};
    if (dateFrom) filter.openedAt.$gte = startOfLocalDayUtc(dateFrom, tz);
    if (dateTo) filter.openedAt.$lte = endOfLocalDayUtc(dateTo, tz);
  }

  const [sessions, total] = await Promise.all([
    SaleSession.find(filter)
      .populate('outlet', 'name code')
      .populate('cashier', 'name email')
      .sort({ openedAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    SaleSession.countDocuments(filter),
  ]);

  const totalsBySession = await getSessionTotals(sessions.filter((session) => session.status === 'open'));
  for (const session of sessions) {
    if (session.status === 'open') session.totals = totalsBySession.get(String(session._id));
  }

  return res.json({
    success: true,
    data: sessions,
    pagination: {
      total,
      page: pageNum,
      limit: pageSize,
      pages: Math.ceil(total / pageSize),
    },
  });
};
