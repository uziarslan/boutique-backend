/**
 * loyalty.service.js — Membership / Rewards core logic.
 *
 * All business rules for earning, redeeming, expiring, and adjusting points
 * live here. Both the POS sale flow (_processSaleCore) and the management
 * loyalty controller call into this module so the rules stay in one place.
 */

import LoyaltyConfig from '../models/LoyaltyConfig.js';
import LoyaltyTransaction from '../models/LoyaltyTransaction.js';
import Customer from '../models/Customer.js';
import {
  postLoyaltyEarn,
  postLoyaltyAdjust,
  postLoyaltyExpiry,
  reverseJournalEntry,
} from '../accounting/journalEngine.js';
import logger from '../utils/logger.js';

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

// ─── Config ───────────────────────────────────────────────────────────────────

export const getOrCreateConfig = async () => {
  let cfg = await LoyaltyConfig.findOne();
  if (!cfg) cfg = await LoyaltyConfig.create({});
  return cfg;
};

// ─── Card numbers ─────────────────────────────────────────────────────────────

const generateCardNumber = async (prefix = 'MC') => {
  // YYYY + 6-digit zero-padded sequential count of cards already issued.
  const year = new Date().getFullYear();
  const count = await Customer.countDocuments({ membershipCardNumber: { $ne: null } });
  return `${prefix}-${year}-${String(count + 1).padStart(6, '0')}`;
};

export const issueCard = async ({ customerId, manualNumber, cashier }) => {
  const cfg = await getOrCreateConfig();
  const customer = await Customer.findById(customerId);
  if (!customer) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 });
  if (customer.membershipCardNumber) {
    throw Object.assign(new Error('Customer already has a card.'), { statusCode: 409 });
  }

  let cardNumber;
  if (cfg.cardNumberMode === 'manual') {
    if (!manualNumber || !manualNumber.trim()) {
      throw Object.assign(new Error('Card number is required (manual mode).'), { statusCode: 422 });
    }
    cardNumber = manualNumber.trim();
    const exists = await Customer.findOne({ membershipCardNumber: cardNumber }).lean();
    if (exists) throw Object.assign(new Error('Card number already in use.'), { statusCode: 409 });
  } else {
    cardNumber = await generateCardNumber(cfg.cardNumberPrefix || 'MC');
  }

  customer.membershipCardNumber = cardNumber;
  customer.membershipCardIssuedAt = new Date();
  await customer.save();

  await LoyaltyTransaction.create({
    customer: customer._id,
    type: 'issue_card',
    points: 0,
    balanceAfter: customer.pointsBalance,
    cashier: cashier ?? null,
    note: `Card issued: ${cardNumber}`,
  });

  return customer;
};

// ─── Earning ──────────────────────────────────────────────────────────────────

/**
 * Compute how many points this sale should earn under the current config.
 * Returns 0 if the customer is missing, the payment method excluded, or the
 * earn rate is zero.
 *
 * @param {object} args
 * @param {object} args.config       - LoyaltyConfig doc
 * @param {string} args.paymentMethod
 * @param {number} args.subtotal     - Pre-tax merchandise total
 * @param {number} args.taxAmount
 * @returns {number} integer points
 */
export const computeEarnPoints = ({ config, paymentMethod, subtotal, taxAmount }) => {
  if (!config) return 0;
  if (!Array.isArray(config.earnOnPaymentMethods) || !config.earnOnPaymentMethods.includes(paymentMethod)) return 0;
  if (!config.pointsPerCurrencyUnit || config.pointsPerCurrencyUnit <= 0) return 0;

  const basis = config.earnBasis === 'subtotalPlusTax'
    ? round2(Number(subtotal || 0) + Number(taxAmount || 0))
    : round2(subtotal || 0);

  return Math.floor(basis * config.pointsPerCurrencyUnit);
};

/**
 * Record an earn event: increment customer balance, write a LoyaltyTransaction,
 * and post the matching journal entry. Caller is responsible for setting
 * SaleTransaction.pointsEarned and loyaltyEarnEntryId.
 */
export const recordEarn = async ({ customerId, points, transaction, config, cashier, outlet }) => {
  if (!points || points <= 0) return null;

  const valuePerPoint = config?.redemptionValue ?? 1;
  const pointsValue = round2(points * valuePerPoint);

  const customer = await Customer.findById(customerId);
  if (!customer) return null;

  customer.pointsBalance = round2((customer.pointsBalance || 0) + points);
  customer.lifetimePointsEarned = round2((customer.lifetimePointsEarned || 0) + points);

  const expiresAt = config?.expiryMonths > 0
    ? new Date(Date.now() + config.expiryMonths * 30 * 24 * 60 * 60 * 1000)
    : null;

  // Maintain earliest-outstanding-batch hint on customer.
  if (expiresAt && (!customer.pointsExpireAt || expiresAt < customer.pointsExpireAt)) {
    customer.pointsExpireAt = expiresAt;
  }

  await customer.save();

  const lt = await LoyaltyTransaction.create({
    customer: customer._id,
    sale: transaction?._id ?? null,
    type: 'earn',
    points,
    valueAtTxn: pointsValue,
    balanceAfter: customer.pointsBalance,
    expiresAt,
    cashier: cashier ?? null,
    outlet: outlet ?? null,
  });

  const je = await postLoyaltyEarn({
    pointsValue,
    transaction,
    loyaltyTxnId: lt._id,
    createdBy: cashier ?? null,
  });
  if (je) {
    lt.journalEntryId = je._id;
    await lt.save();
  }
  return lt;
};

// ─── Redemption ───────────────────────────────────────────────────────────────

/**
 * Validate a redemption request and return { redeemValue, points } or throw.
 * Does NOT mutate state — call recordRedeem after the sale is created.
 */
export const validateRedeem = async ({ customerId, redeemPoints, subtotal, config }) => {
  if (!redeemPoints || redeemPoints <= 0) return { redeemValue: 0, points: 0 };
  if (!config) throw Object.assign(new Error('Loyalty config missing.'), { statusCode: 422 });

  const customer = await Customer.findById(customerId).lean();
  if (!customer) throw Object.assign(new Error('Customer not found for redemption.'), { statusCode: 422 });

  const points = Math.floor(redeemPoints);
  if (points < (config.minRedeemPoints || 0)) {
    throw Object.assign(
      new Error(`Minimum ${config.minRedeemPoints} points required to redeem.`),
      { statusCode: 422 }
    );
  }
  if (points > (customer.pointsBalance || 0)) {
    throw Object.assign(new Error('Insufficient points balance.'), { statusCode: 422 });
  }

  const redeemValue = round2(points * (config.redemptionValue || 0));
  const cap = round2(((config.maxRedeemPercent || 0) / 100) * Number(subtotal || 0));
  if (cap > 0 && redeemValue > cap) {
    throw Object.assign(
      new Error(`Redemption capped at ${config.maxRedeemPercent}% of bill (max ${cap}).`),
      { statusCode: 422 }
    );
  }

  // Hard safety cap that ALWAYS applies (even when maxRedeemPercent is 0 =
  // "unlimited %"): redemption can never exceed the post-discount bill. Otherwise
  // the sale total would clamp to 0 while the journal entry still uses the full
  // redemption value — over-crediting Sales Revenue and over-draining the rewards
  // liability. Redeeming the tax/service portion isn't allowed.
  const billCap = round2(Number(subtotal || 0));
  if (redeemValue > billCap) {
    throw Object.assign(
      new Error(`Redemption (Rs. ${redeemValue}) exceeds the redeemable bill (Rs. ${billCap}).`),
      { statusCode: 422 }
    );
  }

  return { points, redeemValue };
};

/**
 * Apply a validated redemption: decrement balance, write LoyaltyTransaction.
 * The matching debit to liability 2200 is folded into the sale JE by postSale,
 * so we do NOT post a separate JE here.
 */
export const recordRedeem = async ({ customerId, points, redeemValue, transaction, cashier, outlet }) => {
  if (!points || points <= 0) return null;

  const customer = await Customer.findById(customerId);
  if (!customer) return null;

  customer.pointsBalance = round2((customer.pointsBalance || 0) - points);
  customer.lifetimePointsRedeemed = round2((customer.lifetimePointsRedeemed || 0) + points);
  await customer.save();

  return LoyaltyTransaction.create({
    customer: customer._id,
    sale: transaction?._id ?? null,
    type: 'redeem',
    points: -points,
    valueAtTxn: round2(redeemValue),
    balanceAfter: customer.pointsBalance,
    cashier: cashier ?? null,
    outlet: outlet ?? null,
  });
};

// ─── Refund / void reversal ───────────────────────────────────────────────────

/**
 * Reverse the earn and/or redeem entries tied to a sale that was voided or
 * refunded. Honors config.refundReversesPoints.
 */
export const reverseSaleLoyalty = async ({ sale, userId }) => {
  const cfg = await getOrCreateConfig();
  if (!cfg.refundReversesPoints) return;

  const txns = await LoyaltyTransaction.find({ sale: sale._id, type: { $in: ['earn', 'redeem'] } });
  for (const lt of txns) {
    const customer = await Customer.findById(lt.customer);
    if (!customer) continue;

    if (lt.type === 'earn') {
      customer.pointsBalance = round2(Math.max(0, (customer.pointsBalance || 0) - lt.points));
      customer.lifetimePointsEarned = round2(Math.max(0, (customer.lifetimePointsEarned || 0) - lt.points));
    } else if (lt.type === 'redeem') {
      // points stored negative on redeem rows → re-credit absolute value
      const restore = Math.abs(lt.points);
      customer.pointsBalance = round2((customer.pointsBalance || 0) + restore);
      customer.lifetimePointsRedeemed = round2(Math.max(0, (customer.lifetimePointsRedeemed || 0) - restore));
    }
    await customer.save();

    await LoyaltyTransaction.create({
      customer: customer._id,
      sale: sale._id,
      type: 'refund_reversal',
      points: -lt.points,
      valueAtTxn: lt.valueAtTxn,
      balanceAfter: customer.pointsBalance,
      cashier: userId ?? null,
      note: `Reversal of ${lt.type} (sale ${sale.transactionNumber})`,
    });
  }

  // Reverse the standalone earn JE if any (the sale JE itself is reversed by the
  // sale controller via reverseJournalEntry on transaction.journalEntryId).
  if (sale.loyaltyEarnEntryId) {
    try {
      await reverseJournalEntry(sale.loyaltyEarnEntryId, userId ?? null);
    } catch (err) {
      logger.warn(`[loyalty] earn reversal failed for sale ${sale._id}: ${err.message}`);
    }
  }
};

// ─── Adjustment ───────────────────────────────────────────────────────────────

export const adjustBalance = async ({ customerId, deltaPoints, note, userId }) => {
  if (!deltaPoints) throw Object.assign(new Error('deltaPoints is required.'), { statusCode: 422 });
  const cfg = await getOrCreateConfig();
  const customer = await Customer.findById(customerId);
  if (!customer) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 });

  const next = round2((customer.pointsBalance || 0) + deltaPoints);
  if (next < 0) throw Object.assign(new Error('Adjustment would make balance negative.'), { statusCode: 422 });

  customer.pointsBalance = next;
  if (deltaPoints > 0) customer.lifetimePointsEarned = round2((customer.lifetimePointsEarned || 0) + deltaPoints);
  await customer.save();

  const valuePerPoint = cfg.redemptionValue ?? 1;
  const pointsValueDelta = round2(deltaPoints * valuePerPoint);

  const lt = await LoyaltyTransaction.create({
    customer: customer._id,
    type: 'adjust',
    points: deltaPoints,
    valueAtTxn: pointsValueDelta,
    balanceAfter: customer.pointsBalance,
    cashier: userId ?? null,
    note: note || '',
  });

  const je = await postLoyaltyAdjust({
    pointsValueDelta,
    loyaltyTxnId: lt._id,
    note,
    createdBy: userId ?? null,
  });
  if (je) {
    lt.journalEntryId = je._id;
    await lt.save();
  }
  return lt;
};

// ─── Expiry sweep ─────────────────────────────────────────────────────────────

/**
 * Expire all earn batches whose expiresAt < now and are still outstanding.
 * Outstanding = sum(positive earns where expiresAt<now) − sum(redeem rows that
 * post-date the earn). For simplicity we treat redeems as FIFO against the
 * oldest outstanding earn batches and expire whatever remains.
 */
export const runExpirySweep = async ({ userId } = {}) => {
  const cfg = await getOrCreateConfig();
  if (!cfg.expiryMonths || cfg.expiryMonths <= 0) return { expired: 0, customersAffected: 0 };

  const now = new Date();
  // Group expired earns by customer
  const expiredEarns = await LoyaltyTransaction.find({
    type: 'earn',
    expiresAt: { $ne: null, $lt: now },
  }).lean();

  // Build per-customer expired totals; subtract redeems/refund-reversals that
  // already happened to avoid double-expiring already-spent points.
  const byCustomer = new Map();
  for (const e of expiredEarns) {
    const cur = byCustomer.get(String(e.customer)) ?? 0;
    byCustomer.set(String(e.customer), cur + (e.points || 0));
  }

  let totalExpired = 0;
  let customersAffected = 0;

  for (const [customerId, expiredTotal] of byCustomer.entries()) {
    const customer = await Customer.findById(customerId);
    if (!customer) continue;

    // Cap by current balance (FIFO redeems may have already drained these).
    const toExpire = Math.min(expiredTotal, customer.pointsBalance || 0);
    if (toExpire <= 0) {
      // Nothing to expire — but mark these earn rows as already accounted for by
      // setting expiresAt=null so they don't get rescanned forever.
      await LoyaltyTransaction.updateMany(
        { customer: customer._id, type: 'earn', expiresAt: { $lt: now } },
        { $set: { expiresAt: null } }
      );
      continue;
    }

    customer.pointsBalance = round2((customer.pointsBalance || 0) - toExpire);
    await customer.save();

    const value = round2(toExpire * (cfg.redemptionValue || 0));
    const lt = await LoyaltyTransaction.create({
      customer: customer._id,
      type: 'expire',
      points: -toExpire,
      valueAtTxn: value,
      balanceAfter: customer.pointsBalance,
      cashier: userId ?? null,
      note: 'Auto-expiry sweep',
    });

    const je = await postLoyaltyExpiry({
      expiredValue: value,
      breakageAccountCode: cfg.breakageAccountCode || '4003',
      loyaltyTxnId: lt._id,
      createdBy: userId ?? null,
    });
    if (je) {
      lt.journalEntryId = je._id;
      await lt.save();
    }

    // Clear expiresAt on the consumed earn rows.
    await LoyaltyTransaction.updateMany(
      { customer: customer._id, type: 'earn', expiresAt: { $lt: now } },
      { $set: { expiresAt: null } }
    );

    totalExpired += toExpire;
    customersAffected += 1;
  }

  logger.info(`[loyalty] expiry sweep: ${totalExpired} pts across ${customersAffected} customer(s)`);
  return { expired: totalExpired, customersAffected };
};
