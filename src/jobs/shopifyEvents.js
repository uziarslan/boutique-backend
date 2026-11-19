import crypto from 'crypto';
import cron from 'node-cron';
import { env } from '../config/env.js';
import { runWithTenant } from '../db/tenantContext.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyTask from '../models/ShopifyTask.js';
import ShopifyWebhookEvent from '../models/ShopifyWebhookEvent.js';
import RetailVariant from '../models/RetailVariant.js';
import RetailProduct from '../models/RetailProduct.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SaleReturn from '../models/SaleReturn.js';
import JournalEntry from '../models/JournalEntry.js';
import Outlet from '../models/Outlet.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { getBusinessDate } from '../utils/businessDate.js';
import { adjustShopifyInventory, importShopifyCatalog, shopifyGraphql, syncShopifyProductById } from '../services/shopifyAdminApi.js';
import { postSale, postShopifyRefund } from '../accounting/journalEngine.js';
import logger from '../utils/logger.js';

const gid = (type, value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('gid://shopify/') ? raw : `gid://shopify/${type}/${raw}`;
};
const numericId = (value) => String(value || '').split('/').at(-1) || '';
const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const cents = (value) => Math.round(money(value) * 100) / 100;

const claimNextEvent = () => ShopifyWebhookEvent.findOneAndUpdate({
  $or: [
    { status: 'pending', availableAt: { $lte: new Date() } },
    { status: 'processing', leaseUntil: { $lte: new Date() } },
  ],
}, {
  $set: { status: 'processing', leaseUntil: new Date(Date.now() + 60_000), lastError: '' },
  $inc: { attempts: 1 },
}, { new: true, sort: { createdAt: 1 } });

const setEventResult = (event, status, message = '') => ShopifyWebhookEvent.updateOne({ _id: event._id }, {
  $set: {
    status,
    processedAt: status === 'processed' ? new Date() : null,
    leaseUntil: null,
    lastError: String(message || '').slice(0, 1500),
  },
});

const permanent = (message) => Object.assign(new Error(message), { permanent: true });

const syncInventoryLevel = async (event) => {
  const { inventory_item_id: rawItemId, location_id: rawLocationId, available, updated_at: updatedAtRaw } = event.payload || {};
  const itemId = gid('InventoryItem', rawItemId);
  const locationId = gid('Location', rawLocationId);
  if (!itemId || !locationId || !Number.isFinite(Number(available))) throw permanent('Shopify inventory event is missing an inventory item, location, or available quantity.');
  const variant = await RetailVariant.findOne({ shopifyInventoryItemId: itemId });
  if (!variant) throw new Error('Inventory event arrived before its Shopify variant is in the local catalog. Run a catalog sync and retry.');
  const connection = await ShopifyConnection.findOne({ shopDomain: event.shopDomain }).lean();
  const mapping = connection?.locationMappings?.find((entry) => entry.shopifyLocationId === locationId);
  const outletId = mapping?.outlet || null;
  const updatedAt = updatedAtRaw && Number.isFinite(Date.parse(updatedAtRaw)) ? new Date(updatedAtRaw) : new Date();
  const index = variant.inventoryByLocation.findIndex((entry) => entry.shopifyLocationId === locationId);
  const existing = index >= 0 ? variant.inventoryByLocation[index] : null;
  if (existing?.updatedAt && existing.updatedAt > updatedAt) return;
  const oldAvailable = Number(existing?.available || 0);
  const newAvailable = Number(available);
  const key = `shopify:${event.deliveryId}`;
  try {
    await RetailInventoryMovement.create({
      variant: variant._id,
      outlet: outletId,
      shopifyLocationId: locationId,
      quantityDelta: newAvailable - oldAvailable,
      type: 'shopify-sync',
      referenceType: 'shopify-webhook',
      referenceId: event.resourceId,
      idempotencyKey: key,
      syncStatus: 'not-required',
      occurredAt: updatedAt,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  if (index >= 0) {
    variant.inventoryByLocation[index].available = newAvailable;
    variant.inventoryByLocation[index].onHand = newAvailable;
    variant.inventoryByLocation[index].outlet = outletId;
    variant.inventoryByLocation[index].updatedAt = updatedAt;
  } else {
    variant.inventoryByLocation.push({ shopifyLocationId: locationId, outlet: outletId, available: newAvailable, onHand: newAvailable, updatedAt });
  }
  await variant.save();
  await ShopifyConnection.updateOne({ shopDomain: event.shopDomain }, { $set: { lastInventorySyncAt: new Date(), lastError: '' } });
};

const shopifyOrderQuery = `query BoutiqueOrder($id: ID!) {
  order(id: $id) {
    id name createdAt currencyCode displayFinancialStatus cancelledAt
    totalPriceSet { shopMoney { amount currencyCode } }
    totalTaxSet { shopMoney { amount currencyCode } }
    totalDiscountsSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 250) {
      nodes {
        id title sku quantity
        variant { id sku barcode selectedOptions { name value } inventoryItem { unitCost { amount } } }
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
      }
    }
  }
}`;

const syncPaidOrder = async (rawOrderId) => {
  const shopifyOrderId = gid('Order', rawOrderId);
  const existing = await SaleTransaction.findOne({ shopifyOrderId });
  if (existing) {
    if (!existing.journalEntryId) {
      const linkedEntry = await JournalEntry.findOne({ sourceModule: 'pos', sourceId: existing._id, party: 'Shopify Online Sales' });
      if (linkedEntry) existing.journalEntryId = linkedEntry._id;
      else existing.journalEntryId = (await postSale(existing, [], { costOfGoodsSold: existing.items.reduce((sum, item) => sum + Number(item.unitCostSnapshot || 0) * Number(item.qty || 0), 0) }))?._id || null;
      await existing.save();
    }
    return existing;
  }

  const { data } = await shopifyGraphql(shopifyOrderQuery, { id: shopifyOrderId });
  const order = data?.order;
  if (!order) throw new Error(`Shopify order ${rawOrderId} was not found.`);
  const currency = String(order.currencyCode || order.totalPriceSet?.shopMoney?.currencyCode || '').toUpperCase();
  if (currency !== 'PKR') throw permanent(`Shopify order currency ${currency || 'unknown'} cannot be posted to the PKR ledger.`);
  const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
  const outletId = connection?.onlineOrderOutlet || connection?.locationMappings?.find((entry) => entry.isActive !== false)?.outlet;
  const outlet = outletId ? await Outlet.findById(outletId).lean() : await Outlet.findOne({ isActive: { $ne: false } }).lean();
  if (!outlet) throw permanent('Choose an active outlet for online orders in Shopify settings before syncing sales.');

  const lineNodes = order.lineItems?.nodes || [];
  if (!lineNodes.length) throw permanent('Shopify marked an order paid, but the order has no sale lines.');
  const variantIds = lineNodes.map((line) => gid('ProductVariant', line.variant?.id)).filter(Boolean);
  const variants = await RetailVariant.find({ shopifyVariantId: { $in: variantIds } }).lean();
  const variantsById = new Map(variants.map((variant) => [variant.shopifyVariantId, variant]));
  const items = lineNodes.map((line) => {
    const variantId = gid('ProductVariant', line.variant?.id);
    const localVariant = variantsById.get(variantId);
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    const discountedTotal = line.discountedTotalSet?.shopMoney?.amount;
    const unitPrice = money(line.originalUnitPriceSet?.shopMoney?.amount);
    const lineTotal = discountedTotal == null ? cents(unitPrice * qty) : money(discountedTotal);
    return {
      retailVariant: localVariant?._id || null,
      externalItemId: numericId(line.id),
      skuSnapshot: line.variant?.sku || line.sku || localVariant?.sku || '',
      barcodeSnapshot: localVariant?.barcode || line.variant?.barcode || '',
      optionsSnapshot: line.variant?.selectedOptions || [],
      unitCostSnapshot: Number(localVariant?.unitCost ?? line.variant?.inventoryItem?.unitCost?.amount ?? 0),
      unitCostStatusSnapshot: localVariant?.unitCostStatus || (line.variant?.inventoryItem?.unitCost?.amount != null ? 'complete' : 'review'),
      name: String(line.title || 'Shopify product').slice(0, 180),
      qty,
      unitPrice: lineTotal / qty,
      listedUnitPrice: unitPrice,
      priceMode: 'exclusive',
      lineTotal,
      taxAmount: 0,
      serviceChargeAmount: 0,
    };
  });
  const totalAmount = money(order.totalPriceSet?.shopMoney?.amount);
  const taxAmount = money(order.totalTaxSet?.shopMoney?.amount);
  const discountAmount = money(order.totalDiscountsSet?.shopMoney?.amount);
  const deliveryChargeAmount = money(order.totalShippingPriceSet?.shopMoney?.amount);
  if (totalAmount <= 0) throw permanent('Shopify paid order total is missing or zero.');
  const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
  const sale = await SaleTransaction.create({
    outlet: outlet._id,
    businessDate: getBusinessDate(createdAt, outlet.timezone || 'Asia/Karachi', outlet.businessDayStart || '00:00', outlet.businessDayEnd || outlet.businessDayStart || '00:00'),
    cashier: null,
    items,
    subtotal: Math.max(0, totalAmount - taxAmount - deliveryChargeAmount),
    taxAmount,
    effectiveTaxRate: 0,
    serviceChargeAmount: 0,
    deliveryChargeAmount,
    discountAmount,
    discountMode: 'amount',
    totalAmount,
    paymentMethod: 'shopify',
    cashAmount: 0,
    cardAmount: 0,
    onlineTransferAmount: 0,
    status: 'completed',
    source: 'shopify',
    shopifyOrderId,
    shopifyOrderName: String(order.name || '').slice(0, 80),
    shopifyCurrency: currency,
    shopifyFinancialStatus: String(order.displayFinancialStatus || '').toLowerCase(),
    punchedAt: createdAt,
    notes: 'Shopify online order',
    costingStatus: items.some((item) => item.unitCostStatusSnapshot !== 'complete') ? 'review' : 'complete',
  });
  const cogs = items.reduce((sum, item) => sum + Number(item.unitCostSnapshot || 0) * Number(item.qty || 0), 0);
  sale.costOfGoodsSold = cogs;
  sale.journalEntryId = (await postSale(sale, [], { costOfGoodsSold: cogs }))?._id || null;
  await sale.save();
  await ShopifyConnection.updateOne({}, { $set: { lastOrderSyncAt: new Date(), lastError: '' } });
  return sale;
};

const processRefund = async (event) => {
  const payload = event.payload || {};
  const shopifyOrderId = gid('Order', payload.order_id);
  let sale = await SaleTransaction.findOne({ shopifyOrderId });
  if (!sale) sale = await syncPaidOrder(payload.order_id);
  const shopifyRefundId = gid('Refund', payload.id);
  const returnNumber = `SFR-${numericId(payload.id)}`;
  let saleReturn = await SaleReturn.findOne({ shopifyRefundId });
  if (saleReturn?.journalEntry) return;

  const refundLines = payload.refund_line_items || [];
  const transactionRows = (payload.transactions || []).filter((row) => String(row.kind).toLowerCase() === 'refund' && String(row.status).toLowerCase() === 'success');
  const refundAmount = cents(transactionRows.reduce((sum, row) => sum + money(row.amount), 0));
  if (refundAmount <= 0) throw permanent('Shopify refund has no successful refund payment transaction.');
  const priorReturns = await SaleReturn.find({ saleTransaction: sale._id, ...(saleReturn ? { _id: { $ne: saleReturn._id } } : {}) }).lean();
  const alreadyReturned = new Map();
  for (const prior of priorReturns) {
    for (const line of prior.lines || []) {
      alreadyReturned.set(line.originalSaleItemIndex, (alreadyReturned.get(line.originalSaleItemIndex) || 0) + Number(line.quantity || 0));
    }
  }
  const lines = [];
  let taxAmount = 0;
  let cogs = 0;
  for (const refundLine of refundLines) {
    const externalItemId = numericId(refundLine.line_item_id || refundLine.line_item?.id);
    const originalSaleItemIndex = sale.items.findIndex((item) => item.externalItemId === externalItemId);
    if (originalSaleItemIndex < 0) throw permanent(`Refund line ${externalItemId} does not match an imported Shopify sale line.`);
    const original = sale.items[originalSaleItemIndex];
    const quantity = Number(refundLine.quantity || 0);
    if (!Number.isInteger(quantity) || quantity < 1) continue;
    if (!original.retailVariant) throw new Error('Refund product is not linked to the Shopify catalog yet. Import the catalog and retry.');
    if ((alreadyReturned.get(originalSaleItemIndex) || 0) + quantity > Number(original.qty)) {
      throw permanent(`Refund quantity exceeds the remaining quantity on sale line ${externalItemId}.`);
    }
    const restock = String(refundLine.restock_type || '').toLowerCase() === 'return';
    const subtotal = money(refundLine.subtotal);
    const lineTax = money(refundLine.total_tax);
    taxAmount += lineTax;
    if (restock) cogs += Number(original.unitCostSnapshot || 0) * quantity;
    lines.push({
      variant: original.retailVariant,
      originalSaleItemIndex,
      quantity,
      unitRefund: subtotal / quantity,
      restock,
      condition: restock ? 'resalable' : 'other',
      reason: 'Shopify online refund',
    });
  }
  if (!lines.length) throw permanent('Shopify refund has no merchandise lines. Shipping-only refunds need a separately configured return workflow.');
  const shippingAmount = cents((payload.refund_shipping_lines || []).reduce((sum, row) => sum + money(row.subtotal) + money(row.tax), 0));
  if (!saleReturn) {
    saleReturn = await SaleReturn.create({
      returnNumber,
      saleTransaction: sale._id,
      outlet: sale.outlet,
      lines,
      refundAmount,
      refundMethod: 'shopify',
      reason: 'Shopify online refund',
      status: 'completed',
      shopifyRefundId,
    });
  }
  if (!saleReturn.journalEntry) {
    const journal = await postShopifyRefund({ sale, returnNumber, refundAmount, taxAmount, shippingAmount, costOfGoodsSold: cogs, createdAt: payload.created_at ? new Date(payload.created_at) : new Date() });
    saleReturn.journalEntry = journal?._id || null;
    await saleReturn.save();
  }
  const returnedTotal = (await SaleReturn.aggregate([
    { $match: { saleTransaction: sale._id } },
    { $group: { _id: null, amount: { $sum: '$refundAmount' } } },
  ]))[0]?.amount || 0;
  if (returnedTotal >= Number(sale.totalAmount) - 0.01) {
    sale.status = 'refunded';
    sale.isRefund = true;
    await sale.save();
  }
};

const processEvent = async (event) => {
  if (event.topic === 'products/delete') {
    const productId = gid('Product', event.resourceId);
    const deletedAt = new Date();
    const product = await RetailProduct.findOneAndUpdate(
      { shopifyProductId: productId },
      { $set: { deletedAt, isActive: false } },
    ).select('_id').lean();
    if (product) {
      await RetailVariant.updateMany(
        { $or: [{ product: product._id }, { shopifyProductId: productId }] },
        { $set: { deletedAt, isActive: false } },
      );
    }
    return;
  }
  if (event.topic === 'products/create' || event.topic === 'products/update') {
    await syncShopifyProductById(gid('Product', event.resourceId));
    return;
  }
  if (event.topic === 'inventory_levels/update') return syncInventoryLevel(event);
  if (event.topic === 'orders/paid') return syncPaidOrder(event.resourceId);
  if (event.topic === 'orders/cancelled') {
    const sale = await SaleTransaction.findOne({ shopifyOrderId: gid('Order', event.resourceId) });
    if (sale) {
      sale.shopifyFinancialStatus = 'cancelled';
      await sale.save();
    }
    return;
  }
  if (event.topic === 'refunds/create') return processRefund(event);
  throw permanent(`Unsupported Shopify webhook topic ${event.topic}.`);
};

const processTenantEvent = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  return runWithTenant({ conn, slug }, async () => {
    const event = await claimNextEvent();
    if (!event) return false;
    try {
      await processEvent(event);
      await setEventResult(event, 'processed');
    } catch (error) {
      if (error.permanent) {
        await setEventResult(event, 'conflict', error.message);
        logger.warn(`[shopify:${slug}] event ${event.deliveryId} needs review: ${error.message}`);
        return true;
      }
      const final = event.attempts >= 12;
      const delayMs = Math.min(60 * 60_000, 15_000 * (2 ** Math.min(event.attempts - 1, 8)));
      await ShopifyWebhookEvent.updateOne({ _id: event._id }, {
        $set: {
          status: final ? 'failed' : 'pending',
          availableAt: new Date(Date.now() + delayMs),
          leaseUntil: null,
          lastError: String(error.message || 'Shopify event processing failed').slice(0, 1500),
        },
      });
      await ShopifyConnection.updateOne({ shopDomain: event.shopDomain }, { $set: { lastError: String(error.message || '').slice(0, 1000) } });
      logger.warn(`[shopify:${slug}] event ${event.deliveryId} ${final ? 'failed' : 'will retry'}: ${error.message}`);
    }
    return true;
  });
};

const processTenantInventoryMovement = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  return runWithTenant({ conn, slug }, async () => {
    const now = new Date();
    const movement = await RetailInventoryMovement.findOneAndUpdate({
      $or: [
        { syncStatus: 'pending', syncAvailableAt: { $lte: now } },
        { syncStatus: 'processing', syncLeaseUntil: { $lte: now } },
      ],
    }, {
      $set: { syncStatus: 'processing', syncLeaseUntil: new Date(Date.now() + 60_000), syncError: '' },
      $inc: { syncAttempts: 1 },
    }, { new: true, sort: { createdAt: 1 } });
    if (!movement) return false;
    try {
      const variant = await RetailVariant.findById(movement.variant).select('shopifyInventoryItemId tracked').lean();
      if (!variant?.tracked || !variant.shopifyInventoryItemId || !movement.shopifyLocationId) {
        await RetailInventoryMovement.updateOne({ _id: movement._id }, {
          $set: { syncStatus: 'conflict', syncLeaseUntil: null, syncError: 'Variant or Shopify location is not eligible for inventory synchronization.' },
        });
        return true;
      }
      if (!movement.quantityDelta) {
        await RetailInventoryMovement.updateOne({ _id: movement._id }, { $set: { syncStatus: 'synced', syncLeaseUntil: null } });
        return true;
      }
      const group = await adjustShopifyInventory({
        inventoryItemId: variant.shopifyInventoryItemId,
        locationId: movement.shopifyLocationId,
        delta: movement.quantityDelta,
        idempotencyKey: movement.idempotencyKey,
        referenceId: movement._id,
      });
      await RetailInventoryMovement.updateOne({ _id: movement._id }, {
        $set: { syncStatus: 'synced', syncLeaseUntil: null, syncError: '', shopifyMutationId: group.id },
      });
      await ShopifyConnection.updateOne({}, { $set: { lastError: '' } });
    } catch (error) {
      const permanentError = error.permanent === true;
      const maxAttempts = movement.syncAttempts >= 20;
      const final = permanentError || maxAttempts;
      const delayMs = Math.min(60 * 60_000, 15_000 * (2 ** Math.min(movement.syncAttempts - 1, 8)));
      await RetailInventoryMovement.updateOne({ _id: movement._id }, {
        $set: {
          syncStatus: final ? 'conflict' : 'pending',
          syncAvailableAt: new Date(Date.now() + delayMs),
          syncLeaseUntil: null,
          syncError: String(error.message || 'Shopify inventory update failed').slice(0, 1000),
        },
      });
      await ShopifyConnection.updateOne({}, { $set: { lastError: String(error.message || '').slice(0, 1000) } });
      logger.warn(`[shopify:${slug}] inventory movement ${movement._id} ${final ? 'needs review' : 'will retry'}: ${error.message}`);
    }
    return true;
  });
};

const processTenantShopifyTask = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  return runWithTenant({ conn, slug }, async () => {
    const now = new Date();
    const task = await ShopifyTask.findOneAndUpdate({
      $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    }, {
      $set: { status: 'processing', leaseUntil: new Date(Date.now() + 60_000), startedAt: now, lastError: '' },
      $inc: { attempts: 1 },
    }, { new: true, sort: { createdAt: 1 } });
    if (!task) return false;

    try {
      let result = {};
      if (task.type === 'catalog-sync') {
        const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
        if (!connection) throw new Error('Shopify is not connected.');
        const startedAt = task.payload?.startedAt || task.createdAt || now;
        result = await importShopifyCatalog({ onProgress: async (progress) => {
          await ShopifyConnection.updateOne({ _id: connection._id }, { $set: { catalogSync: {
            status: 'running', startedAt, finishedAt: null,
            productsWritten: progress.productsWritten || 0,
            variantsWritten: progress.variantsWritten || 0,
            pages: progress.pages || 0,
            stage: progress.stage || 'Importing Shopify products…',
            error: '',
          } } });
        } });
        await ShopifyConnection.updateOne({ _id: connection._id }, { $set: {
          catalogSync: { status: 'complete', startedAt, finishedAt: new Date(), ...result, stage: 'Catalog sync complete', error: '' },
          lastCatalogSyncAt: new Date(), lastError: '',
        } });
      } else if (task.type === 'product-update') {
        result = await updateShopifyRetailProduct(task.payload.productId, task.payload.productInput, task.payload.variants);
      } else if (task.type === 'barcode-update') {
        result = await updateShopifyVariantBarcode(task.payload.variantId, task.payload.barcode);
      } else if (task.type === 'order-reconcile') {
        result = await reconcileTenant(slug, { lookbackDays: 60 }) || {};
      } else if (task.type === 'webhook-register') {
        const subscriptions = await ensureShopifyWebhookSubscriptions();
        await ShopifyConnection.updateOne({}, { $set: { status: 'connected', webhookSubscriptions: subscriptions, lastError: '' } });
        result = { subscriptions: subscriptions.length };
      } else {
        throw new Error(`Unsupported Shopify task type: ${task.type}`);
      }
      await ShopifyTask.updateOne({ _id: task._id }, { $set: { status: 'complete', result, finishedAt: new Date(), leaseUntil: null, lastError: '' } });
      await ShopifyConnection.updateOne({}, { $set: { lastError: '' } });
    } catch (error) {
      const retry = task.attempts < 5;
      const delayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(task.attempts - 1, 5)));
      await ShopifyTask.updateOne({ _id: task._id }, { $set: {
        status: retry ? 'pending' : 'failed',
        availableAt: retry ? new Date(Date.now() + delayMs) : task.availableAt,
        finishedAt: retry ? null : new Date(),
        leaseUntil: null,
        lastError: String(error.message || 'Shopify task failed').slice(0, 1000),
      } });
      if (task.type === 'catalog-sync' && !retry) {
        await ShopifyConnection.updateOne({}, { $set: { 'catalogSync.status': 'failed', 'catalogSync.finishedAt': new Date(), 'catalogSync.stage': 'Catalog sync failed', 'catalogSync.error': String(error.message || 'Shopify catalog sync failed').slice(0, 1000) } });
      }
      await ShopifyConnection.updateOne({}, { $set: { lastError: String(error.message || '').slice(0, 1000) } });
      logger.warn(`[shopify:${slug}] background task ${task._id} ${retry ? 'will retry' : 'failed'}: ${error.message}`);
    }
    return true;
  });
};

const createReconcileEvent = async (event) => {
  try {
    await ShopifyWebhookEvent.create(event);
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
};

export const reconcileTenant = async (slug, { lookbackDays = 0 } = {}) => {
  const conn = await getTenantConnectionFor(slug);
  return runWithTenant({ conn, slug }, async () => {
    const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
    if (!connection) return;
    await importShopifyCatalog();
    const defaultLookback = new Date(Date.now() - 60 * 24 * 60 * 60_000);
    const baseSince = lookbackDays > 0
      ? new Date(Date.now() - Math.min(60, Number(lookbackDays)) * 24 * 60 * 60_000)
      : connection.lastOrderSyncAt || defaultLookback;
    const since = new Date(baseSince.getTime() - 5 * 60_000).toISOString();
    const query = `query BoutiqueOrderReconciliation($after: String, $search: String!) {
      orders(first: 100, after: $after, sortKey: UPDATED_AT, query: $search) {
        nodes {
          id updatedAt displayFinancialStatus cancelledAt
          refunds(first: 100) {
            id createdAt totalRefundedSet { shopMoney { amount currencyCode } }
            refundLineItems(first: 100) { nodes { lineItem { id } quantity restockType subtotalSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } } }
            refundShippingLines(first: 20) { nodes { subtotalAmountSet { shopMoney { amount } } taxAmountSet { shopMoney { amount } } } }
            transactions(first: 50) { nodes { kind status amountSet { shopMoney { amount currencyCode } } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    let after = null;
    let count = 0;
    do {
      const { data } = await shopifyGraphql(query, { after, search: `updated_at:>=${since}` });
      const orders = data?.orders;
      if (!orders) throw new Error('Shopify did not return orders for reconciliation.');
      for (const order of orders.nodes || []) {
        const rawId = numericId(order.id);
        const status = String(order.displayFinancialStatus || '').toUpperCase();
        const eventHash = crypto.createHash('sha256').update(`${order.id}:${order.updatedAt || ''}`).digest('hex').slice(0, 40);
        if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(status)) {
          await createReconcileEvent({
            deliveryId: `reconcile-paid-${eventHash}`,
            shopDomain: connection.shopDomain,
            topic: 'orders/paid',
            resourceId: rawId,
            payload: { id: rawId },
          });
        }
        if (order.cancelledAt) {
          await createReconcileEvent({
            deliveryId: `reconcile-cancel-${eventHash}`,
            shopDomain: connection.shopDomain,
            topic: 'orders/cancelled',
            resourceId: rawId,
            payload: { id: rawId },
          });
        }
        for (const refund of order.refunds || []) {
          const refundId = numericId(refund.id);
          const refundHash = crypto.createHash('sha256').update(refund.id).digest('hex').slice(0, 40);
          await createReconcileEvent({
            deliveryId: `reconcile-refund-${refundHash}`,
            shopDomain: connection.shopDomain,
            topic: 'refunds/create',
            resourceId: rawId,
            payload: {
              id: refundId,
              order_id: rawId,
              created_at: refund.createdAt,
              refund_line_items: (refund.refundLineItems?.nodes || []).map((line) => ({
                line_item_id: numericId(line.lineItem?.id),
                quantity: line.quantity,
                restock_type: String(line.restockType || '').toLowerCase(),
                subtotal: line.subtotalSet?.shopMoney?.amount,
                total_tax: line.totalTaxSet?.shopMoney?.amount,
              })),
              refund_shipping_lines: (refund.refundShippingLines?.nodes || []).map((line) => ({
                subtotal: line.subtotalAmountSet?.shopMoney?.amount,
                tax: line.taxAmountSet?.shopMoney?.amount,
              })),
              transactions: (refund.transactions?.nodes || []).map((transaction) => ({
                kind: transaction.kind,
                status: transaction.status,
                amount: transaction.amountSet?.shopMoney?.amount,
                currency: transaction.amountSet?.shopMoney?.currencyCode,
              })),
            },
          });
        }
        count += 1;
      }
      after = orders.pageInfo?.hasNextPage ? orders.pageInfo.endCursor : null;
    } while (after);
    await ShopifyConnection.updateOne({ shopDomain: connection.shopDomain }, { $set: { lastOrderSyncAt: new Date(), lastError: '' } });
    logger.info(`[shopify:${slug}] reconciliation queued ${count} changed order(s).`);
    return { queued: count, since };
  });
};

export const runShopifyEvents = async ({ once = false } = {}) => {
  let shuttingDown = false;
  const stop = () => { shuttingDown = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (cron.validate(env.SHOPIFY_RECONCILE_CRON)) {
    cron.schedule(env.SHOPIFY_RECONCILE_CRON, async () => {
      const tenants = await TenantModel().find({ shopifyDomain: { $type: 'string' } }).select('slug').lean();
      for (const tenant of tenants) {
        try { await reconcileTenant(tenant.slug); }
        catch (error) { logger.error(`[shopify:${tenant.slug}] reconciliation failed: ${error.message}`); }
      }
    });
  } else {
    logger.error(`[shopify] Invalid SHOPIFY_RECONCILE_CRON value: ${env.SHOPIFY_RECONCILE_CRON}`);
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (!shuttingDown) {
    const tenants = await TenantModel().find({ shopifyDomain: { $type: 'string' } }).select('slug').lean();
    let didWork = false;
    for (const tenant of tenants) {
      if (await processTenantEvent(tenant.slug)) didWork = true;
      if (await processTenantShopifyTask(tenant.slug)) didWork = true;
      if (await processTenantInventoryMovement(tenant.slug)) didWork = true;
    }
    if (once) return;
    if (!didWork) await pause(env.SHOPIFY_EVENT_POLL_MS);
  }
}
