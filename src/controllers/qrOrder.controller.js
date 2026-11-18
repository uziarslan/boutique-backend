import mongoose from 'mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Outlet from '../models/Outlet.js';
import Table from '../models/Table.js';
import MenuItem from '../models/MenuItem.js';
import Customer from '../models/Customer.js';
import SaleTransaction from '../models/SaleTransaction.js';
import logger from '../utils/logger.js';
import AuditLog from '../models/AuditLog.js';
import { findHeldItemCancellations, cancellationOrderSnapshot } from '../utils/heldItemCancellation.js';
import { getIo } from '../utils/socket.js';
import { getBusinessDate } from '../utils/businessDate.js';
import { DEFAULT_TZ } from '../utils/timezone.js';
import {
  effectiveTaxRate,
  getTaxConfig,
  serviceChargeAppliesTo,
} from '../services/tax.service.js';
import { priceLines } from '../utils/chargeInclusivePricing.js';
import { withQrTableLock } from '../services/qrTableLock.service.js';
import { qrOrderTimingData } from '../services/qrOrderState.service.js';
import {
  getKitchenDeltaItems,
  normalizePrintedQuantityMap,
} from '../utils/kitchenPrintedQuantity.js';
import {
  expandDealItemsForKitchen,
  isDealCurrentlyAvailable,
  loadDealComponentMap,
  resolveDeal,
} from '../services/deal.service.js';

// ─── Socket helpers ──────────────────────────────────────────────────────────
// Two channels exist:
//   qr:cashier:<slug>:<outletId>   — POS terminal subscribes per outlet
//   qr:table:<slug>:<outletCode>:<tableCode>  — customer page subscribes per table
//   qr:order:<slug>:<orderNumber>  — customer page subscribes per placed order
//
// Backend payloads always include the orderNumber so listeners can correlate.

const emitToCashiers = (event, tenantSlug, outletId, payload) => {
  const io = getIo();
  if (!io) return;
  io.to(`qr:cashier:${tenantSlug}:${outletId}`).emit(event, payload);
};

const emitToTable = (event, tenantSlug, outletId, tableCode, payload) => {
  const io = getIo();
  if (!io) return;
  io.to(`qr:table:${tenantSlug}:${outletId}:${tableCode}`).emit(event, payload);
};

const emitToOrder = (event, tenantSlug, orderNumber, payload) => {
  const io = getIo();
  if (!io) return;
  io.to(`qr:order:${tenantSlug}:${orderNumber}`).emit(event, payload);
};

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));
const hashCustomerToken = (token) => createHash('sha256').update(String(token || '')).digest('hex');
const issueCustomerToken = () => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashCustomerToken(token) };
};
const tokenMatches = (token, expectedHash) => {
  const actual = Buffer.from(hashCustomerToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const storedItemsToRaw = (items = []) => (items || [])
  .filter((item) => item?.menuItem)
  .map((item) => ({
    menuItemId: item.menuItem,
    variationId: item.variation?.id || undefined,
    dealSelections: (item.dealSelections || []).map((selection) => ({
      groupId: selection.groupId,
      optionIds: selection.optionIds || [],
    })),
    qty: Number(item.qty || 0),
  }));

const appendNotes = (existing, added) => [existing, added]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join('\n')
  .slice(0, 500);

const pendingAddOnOf = (transaction) => {
  const pending = transaction?.qrOrder?.pendingAddOn;
  return Array.isArray(pending?.items) && pending.items.length > 0 ? pending : null;
};

const plainOrderItems = (items = []) => (items || []).map((item) => (
  typeof item?.toObject === 'function' ? item.toObject() : { ...item }
));

const applyPricing = (transaction, pricing) => {
  transaction.items = pricing.items;
  transaction.subtotal = pricing.subtotal;
  transaction.taxAmount = pricing.taxAmount;
  transaction.effectiveTaxRate = pricing.effectiveTaxRate;
  transaction.serviceChargeAmount = pricing.serviceChargeAmount;
  transaction.discountAmount = 0;
  transaction.totalAmount = pricing.totalAmount;
};

// Table QR orders are always dine-in and have no payment method until the
// cashier settles them. Quote them at the standard (cash) rate, exactly like a
// fresh POS dine-in hold. The final checkout may intentionally switch to a
// reduced digital-payment rate after the cashier selects that payment method.
export const priceQrDineInOrder = async ({
  outletId,
  rawItems,
  taxConfig = null,
  allowUnavailable = false,
}) => {
  // Fold repeat submissions of the same item + size into one line. Different
  // sizes remain separate because each variation has its own price and recipe.
  const requestedById = new Map();
  for (const raw of (Array.isArray(rawItems) ? rawItems : [])) {
    const requestedId = raw?.menuItemId || raw?.menuItem;
    if (!mongoose.isValidObjectId(requestedId)) {
      throw Object.assign(new Error('One or more menu items are invalid.'), { statusCode: 422 });
    }
    const variationId = raw?.variationId || raw?.variation?.id || null;
    if (variationId && !mongoose.isValidObjectId(variationId)) {
      throw Object.assign(new Error('One or more selected sizes are invalid.'), { statusCode: 422 });
    }
    const dealSelections = Array.isArray(raw?.dealSelections) ? raw.dealSelections : [];
    for (const selection of dealSelections) {
      if (!mongoose.isValidObjectId(selection?.groupId)
        || !(selection?.optionIds || []).every((id) => mongoose.isValidObjectId(id))) {
        throw Object.assign(new Error('One or more deal choices are invalid.'), { statusCode: 422 });
      }
    }
    const selectionKey = dealSelections
      .map((selection) => `${String(selection.groupId)}:${(selection.optionIds || []).map(String).sort().join(',')}`)
      .sort()
      .join('|');
    const key = `${String(requestedId)}::${variationId ? String(variationId) : ''}::${selectionKey}`;
    const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
    requestedById.set(key, {
      menuItemId: requestedId,
      variationId,
      dealSelections,
      qty: (requestedById.get(key)?.qty || 0) + qty,
    });
  }
  const requested = [...requestedById.values()];
  const ids = requested
    .map((item) => item.menuItemId || item.menuItem)
    .filter((id) => mongoose.isValidObjectId(id));
  const [menuItems, resolvedTaxConfig] = await Promise.all([
    MenuItem.find({
      _id: { $in: ids },
      outlet: outletId,
      ...(allowUnavailable ? {} : { isAvailable: true }),
    }).lean(),
    taxConfig ? Promise.resolve(taxConfig) : getTaxConfig(outletId),
  ]);
  const byId = new Map(menuItems.map((item) => [String(item._id), item]));
  const dealComponentMap = await loadDealComponentMap(menuItems);

  const items = [];
  for (const raw of requested) {
    const requestedId = raw.menuItemId || raw.menuItem;
    const menuItem = byId.get(String(requestedId));
    if (!menuItem) {
      throw Object.assign(new Error('One or more menu items are no longer available.'), { statusCode: 422 });
    }
    const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
    const hasVariations = Array.isArray(menuItem.variations) && menuItem.variations.length > 0;
    let variation = null;
    if (hasVariations) {
      if (!raw.variationId) {
        throw Object.assign(new Error(`Please choose a size for "${menuItem.name}".`), { statusCode: 422 });
      }
      variation = menuItem.variations.find(
        (candidate) => String(candidate._id) === String(raw.variationId),
      );
      if (!variation) {
        throw Object.assign(
          new Error(`Selected size is no longer available for "${menuItem.name}".`),
          { statusCode: 422 },
        );
      }
    }
    const resolvedDeal = resolveDeal(menuItem, raw.dealSelections, dealComponentMap, { allowUnavailable });
    const unitPrice = round2((variation ? variation.price : menuItem.price) + resolvedDeal.priceAdjustment);
    const taxable = Number(menuItem.taxRate || 0) > 0;
    items.push({
      menuItem: menuItem._id,
      categoryId: menuItem.category,
      variation: variation ? { id: variation._id, name: variation.name } : undefined,
      name: menuItem.name,
      qty,
      listedUnitPrice: unitPrice,
      priceMode: menuItem.priceMode || 'exclusive',
      unitPrice,
      lineTotal: round2(unitPrice * qty),
      taxable,
      dealSelections: resolvedDeal.dealSelections,
      dealComponents: resolvedDeal.dealComponents.map((component) => ({
        source: component.source,
        groupId: component.groupId,
        groupName: component.groupName,
        optionId: component.optionId,
        menuItem: component.menuItem,
        categoryId: component.categoryId,
        categoryName: component.categoryName,
        variation: component.variation,
        name: component.name,
        qtyPerDeal: component.qtyPerDeal,
        priceAdjustment: component.priceAdjustment,
      })),
    });
  }
  const taxRate = effectiveTaxRate(resolvedTaxConfig, 0);
  const serviceChargeRate = serviceChargeAppliesTo(resolvedTaxConfig, 'dine-in')
    ? Number(resolvedTaxConfig.serviceChargeRate || 0)
    : 0;
  const pricing = priceLines(items, { taxRate, serviceChargeRate });
  const pricedItems = pricing.items.map((item) => ({
      menuItem: item.menuItem,
      categoryId: item.categoryId,
      variation: item.variation,
      name: item.name,
      qty: item.qty,
      listedUnitPrice: item.listedUnitPrice,
      priceMode: item.priceMode,
      dealSelections: item.dealSelections,
      dealComponents: item.dealComponents,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      taxRate: item.taxable ? taxRate : 0,
      taxAmount: item.taxAmount,
      serviceChargeRate,
      serviceChargeAmount: item.serviceChargeAmount,
      discountAmount: 0,
    }));

  return {
    items: pricedItems,
    subtotal: pricing.subtotal,
    taxAmount: pricing.taxAmount,
    effectiveTaxRate: taxRate,
    serviceChargeRate,
    serviceChargeAmount: pricing.serviceChargeAmount,
    totalAmount: round2(pricing.subtotal + pricing.taxAmount + pricing.serviceChargeAmount),
  };
};

const publicOrderData = (transaction) => {
  const pendingAddOn = pendingAddOnOf(transaction);
  const visibleItems = pendingAddOn
    ? [...(transaction.items || []), ...(pendingAddOn.items || [])]
    : (transaction.items || []);
  const publicItems = [...visibleItems.reduce((byItem, item) => {
    const variationId = item.variation?.id || '';
    const key = `${String(item.menuItem || item.name || byItem.size)}::${String(variationId)}`;
    const current = byItem.get(key) || {
      name: item.name,
      variationName: item.variation?.name || '',
      qty: 0,
      lineTotal: 0,
    };
    current.qty += Number(item.qty || 0);
    current.lineTotal = round2(current.lineTotal + Number(item.lineTotal || 0));
    byItem.set(key, current);
    return byItem;
  }, new Map()).values()];
  const serviceChargeRate = pendingAddOn
    ? Number(pendingAddOn.combinedServiceChargeRate || 0)
    : Number(
      (transaction.items || []).find((item) => Number(item.serviceChargeRate || 0) > 0)
        ?.serviceChargeRate || 0,
    );
  return {
    orderNumber: transaction.transactionNumber,
    status: transaction.status,
    items: publicItems,
    subtotal: pendingAddOn ? pendingAddOn.combinedSubtotal : transaction.subtotal,
    taxAmount: pendingAddOn ? pendingAddOn.combinedTaxAmount : transaction.taxAmount,
    effectiveTaxRate: pendingAddOn
      ? (pendingAddOn.combinedEffectiveTaxRate || 0)
      : (transaction.effectiveTaxRate || 0),
    serviceChargeAmount: pendingAddOn
      ? (pendingAddOn.combinedServiceChargeAmount || 0)
      : (transaction.serviceChargeAmount || 0),
    serviceChargeRate,
    totalAmount: pendingAddOn ? pendingAddOn.combinedTotalAmount : transaction.totalAmount,
    tableLabel: transaction.qrOrder?.tableLabel,
    declineReason: transaction.qrOrder?.declineReason || transaction.voidReason || '',
    addOnDeclineReason: transaction.qrOrder?.addOnDeclineReason,
    addOnPendingApproval: Boolean(pendingAddOn),
    addOnCount: Number(transaction.qrOrder?.addOnCount || 0),
    kitchenPrintedAt: transaction.kitchenPrintedAt || null,
    ...qrOrderTimingData(transaction),
    billRequest: {
      status: transaction.qrOrder?.billRequest?.status || 'none',
      billType: transaction.qrOrder?.billRequest?.billType || null,
      requestedAt: transaction.qrOrder?.billRequest?.requestedAt || null,
      acknowledgedAt: transaction.qrOrder?.billRequest?.acknowledgedAt || null,
    },
    placedAt: transaction.createdAt,
  };
};

// ─── Public: GET menu for an outlet+table ────────────────────────────────────
// /api/public/menu/:tenantSlug/:outletCode/:tableCode
export const publicGetMenu = async (req, res) => {
  const { outletCode, tableCode } = req.params;

  const outlet = await Outlet.findOne({ code: outletCode, isActive: { $ne: false } })
    .select('_id name code qrOrdering.customerPayment')
    .lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  const table = await Table.findOne({ outlet: outlet._id, code: tableCode, isActive: true })
    .select('_id label code')
    .lean();
  if (!table) return res.status(404).json({ success: false, message: 'Table not available — please ask staff.' });

  const [items, taxConfig] = await Promise.all([
    MenuItem.find({
      outlet: outlet._id,
      isAvailable: true,
      // Missing means enabled so existing menu items remain visible until a
      // manager explicitly turns off their QR self-order channel.
      isAvailableForQrOrder: { $ne: false },
    })
      .populate('category', 'name')
      .populate('dealConfig.fixedItems.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.sortOrder')
      .populate('dealConfig.choiceGroups.options.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.sortOrder')
      .select('name itemType dealConfig price priceMode category description imageUrl taxRate isAvailable variations')
      .sort({ category: 1, name: 1 })
      .lean(),
    getTaxConfig(outlet._id),
  ]);
  const serviceChargeRate = serviceChargeAppliesTo(taxConfig, 'dine-in')
    ? Number(taxConfig.serviceChargeRate || 0)
    : 0;

  // Group by category for the public menu UI.
  const grouped = {};
  for (const it of items) {
    if (!isDealCurrentlyAvailable(it)) continue;
    const cat = it.category?.name || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({
      _id: it._id,
      name: it.name,
      price: it.price,
      priceMode: it.priceMode || 'exclusive',
      taxable: Number(it.taxRate || 0) > 0,
      taxRate: Number(it.taxRate || 0) > 0 ? Number(taxConfig.standardRate || 0) : 0,
      description: it.description || '',
      imageUrl: it.imageUrl || null,
      itemType: it.itemType || 'regular',
      dealConfig: it.itemType === 'deal' ? it.dealConfig : undefined,
      variations: (it.variations || []).map((variation) => ({
        _id: variation._id,
        name: variation.name,
        price: variation.price,
      })),
    });
  }

  // Active orders on this table — used by the customer app to detect the
  // "this table is currently in use by someone else" case. We expose the
  // transaction numbers so the device can match them against its own
  // localStorage and decide whether the visitor is the original customer
  // (continuation flow) or a new visitor (occupied screen).
  const activeOrders = await SaleTransaction.find({
    outlet: outlet._id,
    tableNumber: table.label,
    source: 'qr-self-order',
    status: { $in: ['pending-approval', 'held'] },
  })
    .select('transactionNumber createdAt')
    .lean();

  return res.json({
    success: true,
    data: {
      restaurant: { name: req.tenantOutletName || 'Restaurant', tenantSlug: req.tenantSlug },
      outlet: {
        _id: outlet._id,
        name: outlet.name,
        code: outlet.code,
        customerPayment: outlet.qrOrdering?.customerPayment?.enabled
          ? {
            enabled: true,
            bankName: outlet.qrOrdering.customerPayment.bankName || '',
            accountTitle: outlet.qrOrdering.customerPayment.accountTitle || '',
            accountNumber: outlet.qrOrdering.customerPayment.accountNumber || '',
            iban: outlet.qrOrdering.customerPayment.iban || '',
            instructions: outlet.qrOrdering.customerPayment.instructions || '',
          }
          : null,
      },
      table: {
        _id: table._id,
        label: table.label,
        code: table.code,
        // Active orders on this table that haven't been settled yet.
        activeOrderNumbers: activeOrders.map((o) => o.transactionNumber),
        activeSince: activeOrders[0]?.createdAt || null,
      },
      pricing: {
        orderType: 'dine-in',
        taxRate: Number(taxConfig.standardRate || 0),
        serviceChargeRate,
      },
      categories: Object.keys(grouped).map((name) => ({ name, items: grouped[name] })),
    },
  });
};

// ─── Public: POST place order ────────────────────────────────────────────────
// /api/public/orders/:tenantSlug/:outletCode/:tableCode
export const publicPlaceOrder = async (req, res) => {
  const { outletCode, tableCode } = req.params;
  const { items: rawItems = [], customerPhone, customerName, notes } = req.body || {};

  if (!customerPhone || !String(customerPhone).trim()) {
    return res.status(422).json({ success: false, message: 'Phone number is required.' });
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return res.status(422).json({ success: false, message: 'Cart is empty.' });
  }

  const outlet = await Outlet.findOne({ code: outletCode, isActive: { $ne: false } }).lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  const table = await Table.findOne({ outlet: outlet._id, code: tableCode, isActive: true }).lean();
  if (!table) return res.status(404).json({ success: false, message: 'Table not available.' });

  return withQrTableLock(table._id, async () => {

  // Table-occupancy check: if there are active orders on this table from a
  // DIFFERENT phone, reject. Same phone can keep adding orders. The client
  // also gates this in the UI; this is the server-side enforcement so a
  // direct API call can't bypass it.
  const phone = String(customerPhone).trim();
  const activeOnTable = await SaleTransaction.find({
    outlet: outlet._id,
    tableNumber: table.label,
    source: 'qr-self-order',
    status: { $in: ['pending-approval', 'held'] },
  })
    .select('+qrOrder.customerAccessTokenHash')
    .sort({ createdAt: 1 });
  const occupiedByOtherPhone = activeOnTable.some(
    (o) => o.qrOrder?.customerPhone && o.qrOrder.customerPhone !== phone
  );
  if (occupiedByOtherPhone) {
    return res.status(409).json({
      success: false,
      message: 'This table currently has active orders from another guest. Please ask staff for assistance.',
      code: 'TABLE_OCCUPIED',
    });
  }

  // Resolve prices and charges on the server. The public cart is only a
  // preview; it can never choose a tax or service-charge rate.
  const pricing = await priceQrDineInOrder({ outletId: outlet._id, rawItems });

  // Upsert customer by phone — link points-eligibility on settlement.
  // $setOnInsert handles the brand-new-customer case; $set always writes the
  // current name when provided so a returning customer who supplies a name
  // (or an updated one) gets it stored. The two operators must never touch
  // the same path or Mongo errors with "Updating the path … would create a
  // conflict".
  const trimmedName = customerName && String(customerName).trim();
  const customerUpdate = { $setOnInsert: { phone } };
  if (trimmedName) {
    customerUpdate.$set = { name: trimmedName };
  }
  const customer = await Customer.findOneAndUpdate(
    { phone },
    customerUpdate,
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  // Reuse the first active transaction for this table/customer. This is the
  // important invariant: one occupied QR table has one transaction number,
  // one held order, and therefore one final customer bill.
  const activeTransaction = activeOnTable.find(
    (order) => !order.qrOrder?.customerPhone || order.qrOrder.customerPhone === phone,
  );
  if (activeTransaction) {
    let accessToken = null;
    const addOnAt = new Date();
    activeTransaction.qrOrder = activeTransaction.qrOrder || {};
    activeTransaction.qrOrder.customerPhone = phone;
    if (trimmedName) activeTransaction.qrOrder.customerName = trimmedName;
    activeTransaction.qrOrder.lastAddOnAt = addOnAt;
    activeTransaction.qrOrder.addOnDeclineReason = undefined;
    // Legacy active orders predate customer request tokens. Issue one when
    // that same customer next adds to the order; existing tokens are never
    // reissued because only their hash is retained.
    if (!activeTransaction.qrOrder.customerAccessTokenHash) {
      const issued = issueCustomerToken();
      accessToken = issued.token;
      activeTransaction.qrOrder.customerAccessTokenHash = issued.hash;
    }

    if (activeTransaction.status === 'pending-approval') {
      // Before the first approval the whole order is still pending, so merge
      // straight into the transaction and let the cashier approve it once.
      const combinedPricing = await priceQrDineInOrder({
        outletId: outlet._id,
        rawItems: [...storedItemsToRaw(activeTransaction.items), ...rawItems],
        allowUnavailable: true,
      });
      applyPricing(activeTransaction, combinedPricing);
      activeTransaction.notes = appendNotes(activeTransaction.notes, notes);
      activeTransaction.qrOrder.addOnCount = Number(activeTransaction.qrOrder.addOnCount || 0) + 1;
    } else {
      // Once the original order is in the kitchen, stage only the new delta
      // for cashier approval. The existing held bill remains intact until the
      // add-on is accepted, and its already-printed quantities are preserved.
      const previousPending = pendingAddOnOf(activeTransaction);
      const pendingRawItems = [
        ...storedItemsToRaw(previousPending?.items || []),
        ...rawItems,
      ];
      const [pendingPricing, combinedPricing] = await Promise.all([
        priceQrDineInOrder({ outletId: outlet._id, rawItems: pendingRawItems }),
        priceQrDineInOrder({
          outletId: outlet._id,
          rawItems: [...storedItemsToRaw(activeTransaction.items), ...pendingRawItems],
          allowUnavailable: true,
        }),
      ]);
      activeTransaction.qrOrder.pendingAddOn = {
        items: pendingPricing.items,
        notes: appendNotes(previousPending?.notes, notes),
        submittedAt: addOnAt,
        submissionCount: Number(previousPending?.submissionCount || 0) + 1,
        subtotal: pendingPricing.subtotal,
        taxAmount: pendingPricing.taxAmount,
        effectiveTaxRate: pendingPricing.effectiveTaxRate,
        serviceChargeAmount: pendingPricing.serviceChargeAmount,
        serviceChargeRate: pendingPricing.serviceChargeRate,
        totalAmount: pendingPricing.totalAmount,
        combinedSubtotal: combinedPricing.subtotal,
        combinedTaxAmount: combinedPricing.taxAmount,
        combinedEffectiveTaxRate: combinedPricing.effectiveTaxRate,
        combinedServiceChargeAmount: combinedPricing.serviceChargeAmount,
        combinedServiceChargeRate: combinedPricing.serviceChargeRate,
        combinedTotalAmount: combinedPricing.totalAmount,
      };
    }

    await activeTransaction.save();
    const publicData = publicOrderData(activeTransaction);
    logger.info(`[QR] add-on attached to ${activeTransaction.transactionNumber} | outlet ${outlet.code} | table ${table.label} | phone ${phone} | combined total ${publicData.totalAmount}`);

    emitToCashiers('qr-order:new', req.tenantSlug, String(outlet._id), {
      orderNumber: activeTransaction.transactionNumber,
      tableLabel: table.label,
      tableCode: table.code,
      customerName: trimmedName || customer.name || '',
      customerPhone: phone,
      totalAmount: publicData.totalAmount,
      addOnPendingApproval: activeTransaction.status === 'held',
      placedAt: activeTransaction.createdAt,
    });
    emitToOrder('qr-order:status', req.tenantSlug, activeTransaction.transactionNumber, publicData);

    return res.status(200).json({
      success: true,
      data: { ...publicData, ...(accessToken ? { accessToken } : {}) },
    });
  }

  // Transaction enters at 'pending-approval' so the cashier can vet it
  // before the kitchen ticket prints.
  const issuedToken = issueCustomerToken();
  const transaction = await SaleTransaction.create({
    outlet: outlet._id,
    businessDate: getBusinessDate(
      new Date(),
      outlet.timezone,
      outlet.businessDayStart,
      outlet.businessDayEnd,
    ),
    session: null,         // no session — created by a customer, not a cashier
    cashier: null,         // populated when a cashier approves + later settles
    items: pricing.items,
    subtotal: pricing.subtotal,
    taxAmount: pricing.taxAmount,
    effectiveTaxRate: pricing.effectiveTaxRate,
    serviceChargeAmount: pricing.serviceChargeAmount,
    discountAmount: 0,
    totalAmount: pricing.totalAmount,
    paymentMethod: 'cash', // placeholder until settled
    cashAmount: 0,
    cardAmount: 0,
    status: 'pending-approval',
    isRefund: false,
    syncedToManagement: false,
    notes: notes || '',
    orderType: 'dine-in',
    customer: customer._id,
    tableNumber: table.label,
    source: 'qr-self-order',
    qrOrder: {
      tableCode: table.code,
      tableLabel: table.label,
      customerPhone: phone,
      customerName: customerName || customer.name || '',
      customerAccessTokenHash: issuedToken.hash,
    },
  });

  logger.info(`[QR] order placed: ${transaction.transactionNumber} | outlet ${outlet.code} | table ${table.label} | phone ${phone} | total ${pricing.totalAmount}`);

  // Cashier dashboard learns about the new pending order in real time.
  emitToCashiers('qr-order:new', req.tenantSlug, String(outlet._id), {
    orderNumber: transaction.transactionNumber,
    status: 'pending-approval',
    pendingApproval: true,
    tableLabel: table.label,
    tableCode: table.code,
    customerName: customerName || customer.name || '',
    customerPhone: phone,
    totalAmount: pricing.totalAmount,
    items: pricing.items.map((it) => ({ name: it.name, qty: it.qty, lineTotal: it.lineTotal })),
    placedAt: transaction.createdAt,
  });

  // Other devices on the same table learn the table just became occupied.
  emitToTable('qr-table:occupied', req.tenantSlug, String(outlet._id), table.code, {
    orderNumber: transaction.transactionNumber,
    placedAt: transaction.createdAt,
  });

  return res.status(201).json({
    success: true,
    data: {
      ...publicOrderData(transaction),
      accessToken: issuedToken.token,
    },
  });
  });
};

// ─── Public: POST request the bill ──────────────────────────────────────────
// The order-specific token prevents a visitor who merely knows a transaction
// number from notifying the cashier on somebody else's behalf.
export const publicRequestBill = async (req, res) => {
  const { orderNumber } = req.params;
  const token = String(req.body?.accessToken || '');
  const billType = String(req.body?.billType || '').trim().toLowerCase();
  if (!['cash', 'card'].includes(billType)) {
    return res.status(422).json({
      success: false,
      message: 'Choose either a Cash Bill or Card Bill.',
    });
  }
  let txn = await SaleTransaction.findOne({
    transactionNumber: orderNumber,
    source: 'qr-self-order',
  }).select('+qrOrder.customerAccessTokenHash');
  if (!txn) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (!tokenMatches(token, txn.qrOrder?.customerAccessTokenHash)) {
    return res.status(403).json({ success: false, message: 'This device cannot request the bill for that order.' });
  }
  if (txn.status !== 'held') {
    return res.status(409).json({ success: false, message: 'The bill can be requested after the cashier accepts the order.' });
  }
  if (pendingAddOnOf(txn)) {
    return res.status(409).json({ success: false, message: 'Please wait for the cashier to accept the latest add-on.' });
  }

  let newlyRequested = false;
  if (txn.qrOrder?.billRequest?.status !== 'pending') {
    const now = new Date();
    const updated = await SaleTransaction.findOneAndUpdate(
      {
        _id: txn._id,
        status: 'held',
        'qrOrder.billRequest.status': { $ne: 'pending' },
      },
      {
        $set: {
          'qrOrder.billRequest.status': 'pending',
          'qrOrder.billRequest.billType': billType,
          'qrOrder.billRequest.requestedAt': now,
        },
        $unset: {
          'qrOrder.billRequest.acknowledgedAt': '',
          'qrOrder.billRequest.acknowledgedBy': '',
        },
      },
      { returnDocument: 'after' },
    );
    if (updated) {
      txn = updated;
      newlyRequested = true;
      emitToCashiers('qr-order:bill-requested', req.tenantSlug, String(txn.outlet), {
        orderId: String(txn._id),
        orderNumber: txn.transactionNumber,
        tableLabel: txn.qrOrder?.tableLabel || txn.tableNumber || '',
        customerName: txn.qrOrder?.customerName || '',
        billType,
        requestedAt: now,
      });
    } else {
      txn = await SaleTransaction.findById(txn._id);
    }
  }

  const data = publicOrderData(txn);
  emitToOrder('qr-order:status', req.tenantSlug, txn.transactionNumber, data);
  return res.json({ success: true, data, newlyRequested });
};

// ─── Public: GET order status (for the customer's tracking page) ─────────────
// /api/public/orders/:tenantSlug/:orderNumber
export const publicGetOrder = async (req, res) => {
  const { orderNumber } = req.params;

  const txn = await SaleTransaction.findOne({ transactionNumber: orderNumber, source: 'qr-self-order' })
    .select('transactionNumber status items subtotal taxAmount effectiveTaxRate serviceChargeAmount totalAmount voidReason qrOrder kitchenPrintedAt createdAt')
    .lean();
  if (!txn) return res.status(404).json({ success: false, message: 'Order not found.' });

  return res.json({
    success: true,
    data: publicOrderData(txn),
  });
};

// ─── Cashier: GET pending QR orders for outlet ───────────────────────────────
// /api/pos/qr-orders?outletId=...
export const listQrOrders = async (req, res) => {
  const filter = { source: 'qr-self-order' };
  // Only pending + recently-approved-but-not-settled rows live here.
  filter.status = { $in: ['pending-approval', 'held'] };

  if (req.query.outletId && mongoose.isValidObjectId(req.query.outletId)) {
    filter.outlet = req.query.outletId;
  }

  const orders = await SaleTransaction.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('customer', 'name phone')
    .lean();

  return res.json({
    success: true,
    data: orders.map((order) => ({
      ...order,
      // Keep the stored base and pending delta separate for cashier review,
      // while exposing the exact combined bill totals in one place.
      qrDisplay: publicOrderData(order),
    })),
  });
};

// ─── Cashier: POST acknowledge bill request ────────────────────────────────
export const acknowledgeBillRequest = async (req, res) => {
  const now = new Date();
  const txn = await SaleTransaction.findOneAndUpdate({
    _id: req.params.id,
    source: 'qr-self-order',
    status: 'held',
    'qrOrder.billRequest.status': 'pending',
  }, {
    $set: {
      'qrOrder.billRequest.status': 'acknowledged',
      'qrOrder.billRequest.acknowledgedAt': now,
      'qrOrder.billRequest.acknowledgedBy': req.user.id,
    },
  }, { returnDocument: 'after' });
  if (!txn) {
    const existing = await SaleTransaction.findOne({
      _id: req.params.id,
      source: 'qr-self-order',
      status: 'held',
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Active QR order not found.' });
    return res.json({ success: true, data: existing, alreadyAcknowledged: true });
  }

  const tenantSlug = req.user?.tenantSlug;
  if (tenantSlug) {
    const publicData = publicOrderData(txn);
    emitToOrder('qr-order:status', tenantSlug, txn.transactionNumber, publicData);
    emitToCashiers('qr-order:bill-acknowledged', tenantSlug, String(txn.outlet), {
      orderNumber: txn.transactionNumber,
      acknowledgedAt: now,
    });
  }
  return res.json({ success: true, data: txn });
};

// ─── Cashier: POST approve ───────────────────────────────────────────────────
// /api/pos/qr-orders/:id/approve
export const approveQrOrder = async (req, res) => {
  const located = await SaleTransaction.findById(req.params.id)
    .select('source outlet qrOrder.tableCode')
    .lean();
  if (!located) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (located.source !== 'qr-self-order') {
    return res.status(409).json({ success: false, message: 'Not a self-order.' });
  }
  const table = await Table.findOne({ outlet: located.outlet, code: located.qrOrder?.tableCode })
    .select('_id')
    .lean();
  if (!table) return res.status(409).json({ success: false, message: 'Order table no longer exists.' });

  return withQrTableLock(table._id, async () => {
  const txn = await SaleTransaction.findById(req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Order not found.' });
  const pendingAddOn = pendingAddOnOf(txn);
  const isInitialApproval = txn.status === 'pending-approval';
  const isAddOnApproval = txn.status === 'held' && Boolean(pendingAddOn);
  if (!isInitialApproval && !isAddOnApproval) {
    return res.status(409).json({ success: false, message: `Order is already ${txn.status}.` });
  }
  if (isAddOnApproval && txn.kitchenPrintQueuedAt && !txn.kitchenPrintedAt) {
    return res.status(409).json({
      success: false,
      message: 'The previous kitchen ticket is still being sent. Wait for it to finish, then approve this add-on.',
    });
  }

  let kitchenPrintNotes = txn.notes || '';
  let kitchenPrintItems = plainOrderItems(txn.items);
  if (isAddOnApproval) {
    // Materialize the exact kitchen baseline before pricing folds an identical
    // add-on into an existing line. Computing the delta from the combined order
    // then includes both any old unprinted remainder and the approved add-on,
    // while excluding quantities already printed under another held order.
    const printedBaselineBeforeAddOn = normalizePrintedQuantityMap(
      txn.items,
      txn.kitchenPrintedQtyMap,
      { assumeAllPrinted: Boolean(txn.kitchenPrintedAt || txn.kitchenPrintQueuedAt) },
    );
    const combinedPricing = await priceQrDineInOrder({
      outletId: txn.outlet,
      rawItems: [
        ...storedItemsToRaw(txn.items),
        ...storedItemsToRaw(pendingAddOn.items),
      ],
      allowUnavailable: true,
    });
    applyPricing(txn, combinedPricing);
    kitchenPrintItems = getKitchenDeltaItems(combinedPricing.items, printedBaselineBeforeAddOn);
    kitchenPrintNotes = pendingAddOn.notes || '';
    txn.notes = appendNotes(txn.notes, pendingAddOn.notes);
    txn.qrOrder.addOnCount = Number(txn.qrOrder.addOnCount || 0)
      + Number(pendingAddOn.submissionCount || 1);
    txn.qrOrder.pendingAddOn = undefined;
  }

  txn.status = 'held';
  if (!txn.heldAt) txn.heldAt = new Date();
  txn.cashier = req.user.id; // claim the order so it shows in their held queue
  // Approval opens the print confirmation on the cashier's POS. Do not mark the
  // kitchen ticket as printed until that transfer succeeds and the POS calls
  // the held-order /printed endpoint.
  txn.kitchenPrintedAt = null;
  txn.kitchenPrintQueuedAt = null;
  txn.qrOrder = txn.qrOrder || {};
  kitchenPrintItems = expandDealItemsForKitchen(kitchenPrintItems);
  txn.qrOrder.pendingKitchenCategoryIds = [
    ...new Set(kitchenPrintItems.map((item) => String(item.categoryId || '')).filter(Boolean)),
  ];
  txn.qrOrder.pendingKitchenHasUnassigned = kitchenPrintItems.some((item) => !item.categoryId);
  txn.qrOrder.kitchenStartedAt = undefined;
  txn.qrOrder.readyAt = undefined;
  txn.qrOrder.approvedAt = new Date();
  txn.qrOrder.approvedBy = req.user.id;
  await txn.save();

  logger.info(`[QR] approved: ${txn.transactionNumber} by ${req.user.email}`);

  // Tell the customer's tracking page + the cashier dashboard.
  const tenantSlug = req.user?.tenantSlug;
  if (tenantSlug) {
    emitToOrder('qr-order:status', tenantSlug, txn.transactionNumber, {
      ...publicOrderData(txn),
    });
    emitToCashiers('qr-order:updated', tenantSlug, String(txn.outlet), {
      orderNumber: txn.transactionNumber,
      status: 'held',
      pendingApproval: false,
    });
  }
  return res.json({
    success: true,
    data: {
      ...txn.toObject(),
      kitchenPrintNotes,
      kitchenPrintItems,
      approvedAddOn: isAddOnApproval,
    },
  });
  });
};

// ─── Cashier: POST decline ───────────────────────────────────────────────────
// /api/pos/qr-orders/:id/decline
export const declineQrOrder = async (req, res) => {
  const { reason, prepared } = req.body || {};
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 300) {
    return res.status(400).json({ success: false, message: 'A decline reason of 3–300 characters is required.' });
  }
  if (typeof prepared !== 'boolean') {
    return res.status(422).json({ success: false, message: 'Choose whether the declined order or add-on was already prepared.' });
  }

  const located = await SaleTransaction.findById(req.params.id)
    .select('source outlet qrOrder.tableCode')
    .lean();
  if (!located) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (located.source !== 'qr-self-order') {
    return res.status(409).json({ success: false, message: 'Not a self-order.' });
  }
  const table = await Table.findOne({ outlet: located.outlet, code: located.qrOrder?.tableCode })
    .select('_id')
    .lean();
  if (!table) return res.status(409).json({ success: false, message: 'Order table no longer exists.' });

  return withQrTableLock(table._id, async () => {
  const txn = await SaleTransaction.findById(req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Order not found.' });
  const pendingAddOn = pendingAddOnOf(txn);
  const isAddOnDecline = txn.status === 'held' && Boolean(pendingAddOn);
  if (txn.status !== 'pending-approval' && !isAddOnDecline) {
    return res.status(409).json({ success: false, message: `Order is already ${txn.status}.` });
  }

  const declineReason = String(reason).trim();
  if (isAddOnDecline) {
    txn.qrOrder.pendingAddOn = undefined;
    txn.qrOrder.addOnDeclineReason = declineReason;
    txn.qrOrder.declinedAt = new Date();
    txn.qrOrder.declinedBy = req.user.id;
    await txn.save();

    await AuditLog.create({
      user: req.user.id,
      actorName: req.user.name,
      action: 'qr_order_add_on_declined',
      module: 'pos',
      recordId: txn._id,
      before: { totalAmount: txn.totalAmount },
      after: {
        transactionNumber: txn.transactionNumber,
        totalAmount: txn.totalAmount,
        orderSnapshot: cancellationOrderSnapshot(txn),
        cancellations: findHeldItemCancellations({ items: pendingAddOn.items }, []).map((item) => ({
          ...item, reason: declineReason, prepared,
        })),
      },
      ip: req.ip,
    });

    logger.info(`[QR] add-on declined: ${txn.transactionNumber} by ${req.user.email} | reason: ${declineReason}`);
    const tenantSlug = req.user?.tenantSlug;
    if (tenantSlug) {
      emitToOrder('qr-order:status', tenantSlug, txn.transactionNumber, {
        ...publicOrderData(txn),
        addOnDeclineReason: declineReason,
      });
      emitToCashiers('qr-order:updated', tenantSlug, String(txn.outlet), {
        orderNumber: txn.transactionNumber,
        status: 'held',
        pendingApproval: false,
      });
    }
    return res.json({ success: true, data: txn });
  }

  const outletClock = await Outlet.findById(txn.outlet)
    .select('timezone businessDayStart businessDayEnd')
    .lean();
  if (!outletClock) {
    return res.status(409).json({
      success: false,
      message: 'This order’s business day could not be verified, so it cannot be declined.',
    });
  }
  const voidedAt = new Date();
  txn.status = 'void';
  // A QR order starts without a cashier. Claiming it here makes the acting
  // cashier visible in POS history even when it was declined before approval.
  txn.cashier = req.user.id;
  txn.voidReason = declineReason;
  txn.wasPreparedAtCancellation = prepared;
  txn.voidedAt = voidedAt;
  txn.voidedBy = req.user.id;
  txn.voidBusinessDate = getBusinessDate(
    voidedAt,
    outletClock.timezone || DEFAULT_TZ,
    outletClock.businessDayStart || '00:00',
    outletClock.businessDayEnd || outletClock.businessDayStart || '00:00',
  );
  txn.qrOrder = txn.qrOrder || {};
  txn.qrOrder.declinedAt = new Date();
  txn.qrOrder.declinedBy = req.user.id;
  txn.qrOrder.declineReason = declineReason;
  await txn.save();

  logger.info(`[QR] declined: ${txn.transactionNumber} by ${req.user.email} | reason: ${txn.voidReason}`);

  // Notify the customer (status update) and other tablemates (the
  // table-occupancy lock may now have lifted, so they should re-check).
  const tenantSlug = req.user?.tenantSlug;
  if (tenantSlug) {
    emitToOrder('qr-order:status', tenantSlug, txn.transactionNumber, {
      orderNumber: txn.transactionNumber,
      status: 'void',
      declineReason: txn.voidReason,
    });
    emitToCashiers('qr-order:updated', tenantSlug, String(txn.outlet), {
      orderNumber: txn.transactionNumber,
      status: 'void',
    });
    if (txn.qrOrder?.tableCode) {
      emitToTable('qr-table:freed', tenantSlug, String(txn.outlet), txn.qrOrder.tableCode, {
        orderNumber: txn.transactionNumber,
      });
    }
  }
  return res.json({ success: true, data: txn });
  });
};
