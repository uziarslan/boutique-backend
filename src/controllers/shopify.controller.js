import crypto from 'crypto';
import mongoose from 'mongoose';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyWebhookEvent from '../models/ShopifyWebhookEvent.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import RetailVariant from '../models/RetailVariant.js';
import Outlet from '../models/Outlet.js';
import { encryptShopifySecret, decryptShopifySecret } from '../utils/shopifySecret.js';
import { env } from '../config/env.js';
import { reconcileTenant } from '../jobs/shopifyEvents.js';
import {
  ensureShopifyWebhookSubscriptions,
  fetchShopifyLocations,
  importShopifyCatalog,
  normalizeShopDomain,
  searchRetailCatalog,
  updateShopifyVariantBarcode,
  verifyShopifyCredentials,
} from '../services/shopifyAdminApi.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const publicConnection = (connection) => ({
  shopDomain: connection?.shopDomain || '',
  credentialsConfigured: Boolean(connection?.clientIdEncrypted && connection?.clientSecretEncrypted),
  currency: connection?.currency || 'PKR',
  onlineOrderOutlet: connection?.onlineOrderOutlet || null,
  status: connection?.status || 'disconnected',
  locationMappings: connection?.locationMappings || [],
  webhookSubscriptions: connection?.webhookSubscriptions || [],
  lastCatalogSyncAt: connection?.lastCatalogSyncAt || null,
  lastInventorySyncAt: connection?.lastInventorySyncAt || null,
  lastOrderSyncAt: connection?.lastOrderSyncAt || null,
  lastError: connection?.lastError || '',
});

export const getShopifySettings = async (_req, res) => {
  const [connection, outlets] = await Promise.all([
    ShopifyConnection.findOne({}).select('+clientIdEncrypted +clientSecretEncrypted').lean(),
    Outlet.find({ isActive: { $ne: false } }).select('_id name code').sort({ name: 1 }).lean(),
  ]);
  res.json({ success: true, data: { connection: publicConnection(connection), outlets } });
};

export const connectShopify = async (req, res) => {
  const shopDomain = normalizeShopDomain(req.body?.shopDomain);
  let clientId = String(req.body?.clientId || '').trim();
  let clientSecret = String(req.body?.clientSecret || '').trim();
  const existing = await ShopifyConnection.findOne({}).select('+clientIdEncrypted +clientSecretEncrypted').lean();
  if (!clientId && !clientSecret && existing?.shopDomain === shopDomain) {
    clientId = decryptShopifySecret(existing.clientIdEncrypted);
    clientSecret = decryptShopifySecret(existing.clientSecretEncrypted);
  }
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw fail('Enter both the Shopify app client ID and client secret, or leave both blank to keep the saved credentials.');
  }
  if (!shopDomain || !clientId || !clientSecret) {
    throw fail('Shop domain, app client ID, and app client secret are required.');
  }
  if (clientId.length > 500 || clientSecret.length > 500) throw fail('Shopify credentials are too long.');

  const shop = await verifyShopifyCredentials({ shopDomain, clientId, clientSecret });
  if (shop.currencyCode !== 'PKR') {
    throw fail(`This boutique is configured for PKR, but Shopify reports ${shop.currencyCode}. Set the Shopify store currency to PKR before connecting.`, 409);
  }

  let onlineOrderOutletId = req.body?.onlineOrderOutlet || null;
  if (!onlineOrderOutletId) {
    onlineOrderOutletId = String((await Outlet.findOne({ isActive: { $ne: false } }).select('_id').lean())?._id || '');
  }
  if (!onlineOrderOutletId) throw fail('Create an active outlet before connecting Shopify.', 409);
  if (onlineOrderOutletId && !mongoose.isValidObjectId(onlineOrderOutletId)) throw fail('Choose a valid outlet for online orders.');
  if (onlineOrderOutletId && !(await Outlet.exists({ _id: onlineOrderOutletId, isActive: { $ne: false } }))) {
    throw fail('The selected online-order outlet does not exist or is inactive.', 404);
  }

  const connection = await ShopifyConnection.findOneAndUpdate({}, {
    $set: {
      shopDomain,
      clientIdEncrypted: encryptShopifySecret(clientId),
      clientSecretEncrypted: encryptShopifySecret(clientSecret),
      apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
      currency: 'PKR',
      onlineOrderOutlet: onlineOrderOutletId,
      status: 'attention',
      lastError: '',
      configuredBy: req.user?.id || null,
    },
    $unset: { accessTokenEncrypted: 1 },
  }, { upsert: true, new: true, runValidators: true });

  try {
    await TenantModel().updateOne({ slug: req.tenantSlug }, { $set: { shopifyDomain: shopDomain } });
    const subscriptions = await ensureShopifyWebhookSubscriptions();
    connection.status = 'connected';
    connection.webhookSubscriptions = subscriptions;
    await connection.save();
    return res.json({ success: true, data: { connection: publicConnection(connection), shop: { name: shop.name, currencyCode: shop.currencyCode } } });
  } catch (error) {
    connection.status = 'attention';
    connection.lastError = String(error.message || 'Webhook setup failed').slice(0, 1000);
    await connection.save();
    return res.status(error.statusCode || 200).json({
      success: false,
      message: 'Shopify credentials were verified and saved, but webhook setup needs attention.',
      data: { connection: publicConnection(connection) },
      error: connection.lastError,
    });
  }
};

export const registerShopifyWebhooks = async (_req, res) => {
  const subscriptions = await ensureShopifyWebhookSubscriptions();
  await ShopifyConnection.updateOne({}, { $set: { status: 'connected', webhookSubscriptions: subscriptions, lastError: '' } });
  res.json({ success: true, data: { subscriptions } });
};

export const getShopifyLocations = async (_req, res) => {
  const locations = await fetchShopifyLocations();
  res.json({ success: true, data: locations });
};

export const saveShopifyLocationMappings = async (req, res) => {
  const input = req.body?.locationMappings;
  if (!Array.isArray(input) || input.length > 250) throw fail('Provide a list of Shopify location to outlet mappings.');
  const validOutlets = new Set((await Outlet.find({ isActive: { $ne: false } }).distinct('_id')).map(String));
  const locations = new Set((await fetchShopifyLocations()).map((location) => location.id));
  const mappings = [];
  const seenLocations = new Set();
  for (const item of input) {
    const shopifyLocationId = String(item?.shopifyLocationId || '').trim();
    const outlet = String(item?.outlet || '').trim();
    if (!locations.has(shopifyLocationId)) throw fail(`Shopify location ${shopifyLocationId || '(blank)'} was not found.`);
    if (!validOutlets.has(outlet)) throw fail(`Outlet ${outlet || '(blank)'} is not available.`);
    if (seenLocations.has(shopifyLocationId)) throw fail(`Shopify location ${shopifyLocationId} is mapped more than once.`);
    seenLocations.add(shopifyLocationId);
    mappings.push({ shopifyLocationId, name: String(item.name || '').trim().slice(0, 120), outlet, isActive: true });
  }
  const onlineOrderOutlet = req.body?.onlineOrderOutlet ? String(req.body.onlineOrderOutlet) : null;
  if (onlineOrderOutlet && !validOutlets.has(onlineOrderOutlet)) throw fail('Choose a valid online-order outlet.');
  const update = { locationMappings: mappings };
  if (onlineOrderOutlet) update.onlineOrderOutlet = onlineOrderOutlet;
  await ShopifyConnection.updateOne({}, { $set: update });
  res.json({ success: true, data: { locationMappings: mappings, onlineOrderOutlet } });
};

export const syncShopifyCatalog = async (_req, res) => {
  const summary = await importShopifyCatalog();
  res.json({ success: true, data: summary });
};

export const reconcileShopifyOrders = async (req, res) => {
  const result = await reconcileTenant(req.tenantSlug, { lookbackDays: 60 });
  res.json({ success: true, data: result || { queued: 0 } });
};

export const getShopifyEvents = async (_req, res) => {
  const events = await ShopifyWebhookEvent.find({}).sort({ createdAt: -1 }).limit(100)
    .select('deliveryId eventId topic resourceId status attempts availableAt processedAt lastError createdAt').lean();
  res.json({ success: true, data: events });
};

export const retryShopifyEvent = async (req, res) => {
  const event = await ShopifyWebhookEvent.findById(req.params.eventId);
  if (!event) throw fail('Shopify event not found.', 404);
  if (!['failed', 'conflict'].includes(event.status)) throw fail('Only failed or conflicted Shopify events can be retried.', 409);
  event.status = 'pending';
  event.attempts = 0;
  event.availableAt = new Date();
  event.leaseUntil = null;
  event.processedAt = null;
  event.lastError = '';
  await event.save();
  res.json({ success: true, data: { _id: event._id, status: event.status } });
};

export const getShopifyInventoryConflicts = async (_req, res) => {
  const movements = await RetailInventoryMovement.find({ syncStatus: { $in: ['conflict', 'failed'] } })
    .sort({ createdAt: -1 }).limit(100)
    .populate({ path: 'variant', select: 'title sku barcode shopifyInventoryItemId', populate: { path: 'product', select: 'title' } })
    .populate('outlet', 'name code').lean();
  res.json({ success: true, data: movements });
};

export const retryShopifyInventoryMovement = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.movementId)) throw fail('Inventory movement not found.', 404);
  const movement = await RetailInventoryMovement.findById(req.params.movementId);
  if (!movement) throw fail('Inventory movement not found.', 404);
  if (!['conflict', 'failed'].includes(movement.syncStatus)) throw fail('Only failed or conflicted inventory updates can be retried.', 409);
  movement.syncStatus = 'pending';
  movement.syncLeaseUntil = null;
  movement.syncAvailableAt = new Date();
  movement.syncError = '';
  await movement.save();
  res.json({ success: true, data: { _id: movement._id, syncStatus: movement.syncStatus } });
};

export const searchBoutiqueCatalog = async (req, res) => {
  const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 100));
  const catalog = await searchRetailCatalog({ search: String(req.query.q || ''), outletId: req.query.outletId || null, limit, page: req.query.page });
  res.json({ success: true, data: catalog });
};

export const editRetailBarcode = async (req, res) => {
  const barcode = String(req.body?.barcode || '').trim();
  if (barcode.length > 80) throw fail('Barcode must be 80 characters or fewer.');
  const variant = await RetailVariant.findById(req.params.variantId);
  if (!variant) throw fail('Retail variant not found.', 404);
  const connectedShopify = variant.shopifyVariantId && await ShopifyConnection.exists({ status: 'connected' });
  const result = connectedShopify
    ? await updateShopifyVariantBarcode(req.params.variantId, barcode)
    : await (async () => {
      variant.barcode = barcode;
      variant.barcodeSyncStatus = variant.shopifyVariantId ? 'failed' : 'synced';
      variant.barcodeSyncError = variant.shopifyVariantId ? 'Saved locally. Re-save this barcode after Shopify is connected to update the online catalog.' : '';
      await variant.save();
      return { _id: variant._id, barcode: variant.barcode, barcodeSyncStatus: variant.barcodeSyncStatus, barcodeSyncError: variant.barcodeSyncError };
    })();
  res.json({ success: true, data: result });
};

const EVENT_TOPICS = new Set([
  'products/create', 'products/update', 'products/delete',
  'inventory_levels/update', 'orders/paid', 'orders/cancelled', 'refunds/create',
]);

const idString = (value) => value == null ? '' : String(value);
const eventResourceId = (topic, payload) => {
  if (topic.startsWith('products/')) return idString(payload.id);
  if (topic.startsWith('orders/')) return idString(payload.id || payload.order_id);
  if (topic === 'refunds/create') return idString(payload.order_id);
  if (topic.startsWith('inventory_levels/')) return idString(payload.inventory_item_id);
  return '';
};

const sanitizedPayload = (topic, payload) => {
  if (topic.startsWith('products/')) return { id: idString(payload.id), updated_at: payload.updated_at || null };
  if (topic === 'inventory_levels/update') return {
    inventory_item_id: idString(payload.inventory_item_id),
    location_id: idString(payload.location_id),
    available: Number.isFinite(Number(payload.available)) ? Number(payload.available) : null,
    updated_at: payload.updated_at || null,
  };
  if (topic.startsWith('orders/')) return {
    id: idString(payload.id), name: String(payload.name || '').slice(0, 80),
    currency: String(payload.currency || '').slice(0, 3),
    financial_status: String(payload.financial_status || '').slice(0, 40),
    updated_at: payload.updated_at || null,
  };
  if (topic === 'refunds/create') return {
    id: idString(payload.id), order_id: idString(payload.order_id),
    created_at: payload.created_at || null,
    note: String(payload.note || '').slice(0, 200),
    refund_line_items: (payload.refund_line_items || []).map((line) => ({
      line_item_id: idString(line.line_item_id || line.line_item?.id),
      quantity: Number(line.quantity || 0),
      restock_type: String(line.restock_type || '').slice(0, 30),
      subtotal: line.subtotal,
      total_tax: line.total_tax,
    })),
    refund_shipping_lines: (payload.refund_shipping_lines || []).map((line) => ({ subtotal: line.subtotal, tax: line.tax })),
    transactions: (payload.transactions || []).map((transaction) => ({
      kind: String(transaction.kind || '').slice(0, 30),
      status: String(transaction.status || '').slice(0, 30),
      amount: transaction.amount,
      currency: String(transaction.currency || '').slice(0, 3),
    })),
  };
  return {};
};

export const receiveShopifyWebhook = async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Expected the raw Shopify request body.' });
  const shopDomain = normalizeShopDomain(req.get('x-shopify-shop-domain'));
  const topic = String(req.get('x-shopify-topic') || '').trim().toLowerCase();
  const deliveryId = String(req.get('x-shopify-webhook-id') || '').trim();
  const signature = String(req.get('x-shopify-hmac-sha256') || '').trim();
  if (!shopDomain || !EVENT_TOPICS.has(topic) || !deliveryId || !signature) return res.status(400).json({ error: 'Invalid Shopify webhook headers.' });

  const tenant = await TenantModel().findOne({ shopifyDomain: shopDomain }).select('slug').lean();
  if (!tenant?.slug) return res.status(404).json({ error: 'Unknown Shopify shop.' });
  const conn = await getTenantConnectionFor(tenant.slug);
  const accepted = await runWithTenant({ conn, slug: tenant.slug }, async () => {
    const connection = await ShopifyConnection.findOne({ shopDomain, status: { $ne: 'disconnected' } })
      .select('+clientSecretEncrypted').lean();
    const secret = decryptShopifySecret(connection?.clientSecretEncrypted);
    if (!secret) return { status: 503, body: { error: 'Shopify webhook secret unavailable.' } };
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
    const received = Buffer.from(signature, 'base64');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return { status: 401, body: { error: 'Invalid Shopify webhook signature.' } };
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return { status: 400, body: { error: 'Invalid webhook JSON.' } }; }
    const safePayload = sanitizedPayload(topic, payload);
    if (topic === 'refunds/create' && !safePayload.id) return { status: 400, body: { error: 'Shopify refund is missing its refund ID.' } };
    if (!eventResourceId(topic, payload)) return { status: 400, body: { error: 'Shopify webhook is missing its resource ID.' } };
    try {
      await ShopifyWebhookEvent.create({
        deliveryId,
        eventId: String(req.get('x-shopify-event-id') || '').trim(),
        shopDomain,
        topic,
        resourceId: eventResourceId(topic, payload),
        payload: safePayload,
      });
    } catch (error) {
      if (error?.code === 11000) return { status: 200, body: { received: true, duplicate: true } };
      throw error;
    }
    return { status: 200, body: { received: true } };
  });
  return res.status(accepted.status).json(accepted.body);
};
