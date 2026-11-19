import crypto from 'crypto';
import mongoose from 'mongoose';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyTask from '../models/ShopifyTask.js';
import ShopifyWebhookEvent from '../models/ShopifyWebhookEvent.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import RetailVariant from '../models/RetailVariant.js';
import RetailProduct from '../models/RetailProduct.js';
import Outlet from '../models/Outlet.js';
import { encryptShopifySecret, decryptShopifySecret } from '../utils/shopifySecret.js';
import { env } from '../config/env.js';
import {
  fetchShopifyLocations,
  normalizeShopDomain,
  searchRetailCatalog,
  verifyShopifyCredentials,
} from '../services/shopifyAdminApi.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const enqueueShopifyTask = (type, payload = {}) => ShopifyTask.create({ type, payload, status: 'pending', availableAt: new Date() });
const publicTask = (task) => ({
  _id: task._id,
  type: task.type,
  status: task.status,
  attempts: task.attempts,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
  lastError: task.lastError || '',
  createdAt: task.createdAt,
});
const publicConnection = (connection) => ({
  shopDomain: connection?.shopDomain || '',
  currency: connection?.currency || 'PKR',
  onlineOrderOutlet: connection?.onlineOrderOutlet || null,
  status: connection?.status || 'disconnected',
  locationMappings: connection?.locationMappings || [],
  webhookSubscriptions: connection?.webhookSubscriptions || [],
  lastCatalogSyncAt: connection?.lastCatalogSyncAt || null,
  catalogSync: connection?.catalogSync || { status: 'idle', productsWritten: 0, variantsWritten: 0, pages: 0, stage: '', error: '' },
  lastInventorySyncAt: connection?.lastInventorySyncAt || null,
  lastOrderSyncAt: connection?.lastOrderSyncAt || null,
  lastError: connection?.lastError || '',
});

export const getShopifySettings = async (_req, res) => {
  const [connection, outlets, tasks] = await Promise.all([
    ShopifyConnection.findOne({}).lean(),
    Outlet.find({ isActive: { $ne: false } }).select('_id name code').sort({ name: 1 }).lean(),
    ShopifyTask.find({}).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  res.json({ success: true, data: { connection: { ...publicConnection(connection), shopDomain: connection?.shopDomain || env.SHOPIFY_SHOP_DOMAIN }, outlets, backgroundTasks: tasks.map(publicTask) } });
};

export const connectShopify = async (req, res) => {
  const shopDomain = normalizeShopDomain(req.body?.shopDomain || env.SHOPIFY_SHOP_DOMAIN);
  const clientId = String(req.body?.clientId || env.SHOPIFY_CLIENT_ID || '').trim();
  const clientSecret = String(req.body?.clientSecret || env.SHOPIFY_CLIENT_SECRET || '').trim();
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
    const task = await enqueueShopifyTask('webhook-register');
    connection.status = 'connected';
    connection.webhookSubscriptions = [];
    await connection.save();
    return res.status(202).json({ success: true, data: { connection: publicConnection(connection), task: publicTask(task), message: 'Shopify is connected. Webhook registration is running in the background.', shop: { name: shop.name, currencyCode: shop.currencyCode } } });
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
  const connection = await ShopifyConnection.findOne({}).lean();
  if (!connection) throw fail('Connect Shopify before registering webhooks.', 409);
  const task = await enqueueShopifyTask('webhook-register');
  await ShopifyConnection.updateOne({}, { $set: { lastError: '' } });
  res.status(202).json({ success: true, data: { task: publicTask(task), message: 'Webhook registration queued.' } });
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
  const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
  if (!connection) throw fail('Shopify is not connected.', 409);
  if (connection.catalogSync?.status === 'running') throw fail('A catalog sync is already running. Check the progress below.', 409);
  const startedAt = new Date();
  await ShopifyConnection.updateOne({ _id: connection._id }, { $set: {
    catalogSync: { status: 'running', startedAt, finishedAt: null, productsWritten: 0, variantsWritten: 0, pages: 0, stage: 'Connecting to Shopify…', error: '' },
    lastError: '',
  } });
  let task;
  try {
    task = await enqueueShopifyTask('catalog-sync', { startedAt });
  } catch (error) {
    await ShopifyConnection.updateOne({ _id: connection._id }, { $set: {
      'catalogSync.status': 'failed', 'catalogSync.finishedAt': new Date(),
      'catalogSync.stage': 'Could not queue catalog sync', 'catalogSync.error': String(error.message || 'Could not queue catalog sync').slice(0, 1000),
    } });
    throw error;
  }
  res.status(202).json({ success: true, data: { task: publicTask(task), message: 'Catalog sync queued.' } });
};

export const reconcileShopifyOrders = async (req, res) => {
  const task = await enqueueShopifyTask('order-reconcile', { requestedBy: req.user?.id || null });
  res.status(202).json({ success: true, data: { task: publicTask(task), message: 'Recent order sync queued.' } });
};

export const getShopifyEvents = async (req, res) => {
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const total = await ShopifyWebhookEvent.countDocuments({});
  const totalPages = Math.ceil(total / pageSize);
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const events = await ShopifyWebhookEvent.find({}).sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * pageSize).limit(pageSize)
    .select('deliveryId eventId topic resourceId status attempts availableAt processedAt lastError createdAt').lean();
  res.json({ success: true, data: { items: events, total, page, pageSize, totalPages } });
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
  const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 50));
  const canViewInactive = req.user?.role === 'owner' || req.user?.hasPermission?.('inventory.manage');
  const includeInactive = req.query.includeInactive === 'true' && canViewInactive;
  // The Finished Goods page sends `all` as the default value for each filter.
  // Treat it as an unset filter; otherwise these strings become literal Mongo
  // matches (for example productType: 'all') and hide the entire catalog.
  const optionalFilter = (value) => {
    const normalized = String(value || '').trim();
    return normalized.toLowerCase() === 'all' ? '' : normalized;
  };
  const status = ['active', 'draft', 'archived'].includes(String(req.query.status || '').toLowerCase())
    ? String(req.query.status).toLowerCase()
    : 'all';
  const catalog = await searchRetailCatalog({
    search: String(req.query.q || ''), outletId: req.query.outletId || null, limit, page: req.query.page, includeInactive, status,
    source: ['manual', 'shopify'].includes(req.query.source) ? req.query.source : 'all',
    type: optionalFilter(req.query.type), vendor: optionalFilter(req.query.vendor), tag: optionalFilter(req.query.tag),
    size: optionalFilter(req.query.size), color: optionalFilter(req.query.color), optionValue: optionalFilter(req.query.optionValue),
    stock: ['in', 'out'].includes(req.query.stock) ? req.query.stock : 'all',
    tracked: ['yes', 'no'].includes(req.query.tracked) ? req.query.tracked : 'all',
    barcode: ['has', 'missing'].includes(req.query.barcode) ? req.query.barcode : 'all',
    minPrice: req.query.minPrice, maxPrice: req.query.maxPrice, sort: String(req.query.sort || 'name'),
    withFilterOptions: req.query.withFilterOptions === 'true',
  });
  res.json({ success: true, data: catalog });
};

export const getRetailProduct = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.productId)) throw fail('Retail product not found.', 404);
  const product = await RetailProduct.findById(req.params.productId).lean();
  if (!product || product.deletedAt) throw fail('Retail product not found.', 404);
  const variants = await RetailVariant.find({ product: product._id }).sort({ sku: 1, title: 1 }).lean();
  res.json({ success: true, data: { product, variants } });
};

export const editRetailProduct = async (req, res) => {
  const product = await RetailProduct.findById(req.params.productId);
  if (!product || product.deletedAt) throw fail('Retail product not found.', 404);
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const productType = String(req.body?.productType || '').trim();
  const vendor = String(req.body?.vendor || '').trim();
  const handle = String(req.body?.handle || '').trim();
  const status = String(req.body?.status || '').toLowerCase();
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const inputVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];
  if (!title || title.length > 150 || description.length > 5000 || productType.length > 80 || vendor.length > 120 || handle.length > 255) {
    throw fail('Check the product name, description, type, vendor, and handle lengths.');
  }
  if (!['active', 'draft', 'archived'].includes(status)) throw fail('Choose Active, Draft, or Archived status.');
  if (tags.length > 100 || tags.some((tag) => tag.length > 255)) throw fail('Use up to 100 tags, each 255 characters or fewer.');
  const variants = inputVariants.map((item) => ({
    id: String(item?.id || ''),
    title: String(item?.title || '').trim().slice(0, 100),
    sku: String(item?.sku || '').trim().slice(0, 100),
    barcode: String(item?.barcode || '').trim().slice(0, 80),
    price: Number(item?.price),
    compareAtPrice: item?.compareAtPrice === '' || item?.compareAtPrice == null ? null : Number(item.compareAtPrice),
    unitCost: item?.unitCost === '' || item?.unitCost == null ? null : Number(item.unitCost),
    tracked: item?.tracked !== false,
    inventoryPolicy: String(item?.inventoryPolicy || 'DENY').toUpperCase(),
    options: Array.isArray(item?.options) ? item.options.map((option) => ({ name: String(option?.name || '').trim(), value: String(option?.value || '').trim() })) : [],
  }));
  if (!variants.length || variants.length > 100 || variants.some((variant) => !variant.id || !variant.title || !Number.isFinite(variant.price) || variant.price < 0 || (variant.compareAtPrice != null && (!Number.isFinite(variant.compareAtPrice) || variant.compareAtPrice < 0)) || (variant.unitCost != null && (!Number.isFinite(variant.unitCost) || variant.unitCost < 0)) || !['DENY', 'CONTINUE'].includes(variant.inventoryPolicy))) {
    throw fail('Each variant needs a name and valid prices.');
  }
  const skus = variants.map((variant) => variant.sku).filter(Boolean);
  const barcodes = variants.map((variant) => variant.barcode).filter(Boolean);
  if (new Set(skus).size !== skus.length || new Set(barcodes).size !== barcodes.length) throw fail('Each SKU and barcode must be unique within this product.');
  const existingVariants = await RetailVariant.find({ product: product._id }).select('_id').lean();
  const existingIds = new Set(existingVariants.map((variant) => String(variant._id)));
  if (variants.length !== existingIds.size || variants.some((variant) => !existingIds.has(variant.id))) throw fail('The product variants changed. Refresh the page before editing.', 409);
  const editedIds = variants.map((variant) => variant.id);
  if (skus.length && await RetailVariant.exists({ sku: { $in: skus }, _id: { $nin: editedIds } })) throw fail('A SKU is already used by another catalog variant.', 409);
  if (barcodes.length && await RetailVariant.exists({ barcode: { $in: barcodes }, _id: { $nin: editedIds } })) throw fail('A barcode is already used by another catalog variant.', 409);

  const productInput = { title, description, productType, vendor, handle, tags, status };
  if (product.shopifyProductId) {
    const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
    if (!connection) throw fail('Connect Shopify before editing this Shopify-linked product.', 409);
    const task = await enqueueShopifyTask('product-update', { productId: String(product._id), productInput, variants });
    product.set({ ...productInput, isActive: status === 'active' });
    await product.save();
    await Promise.all(variants.map((variant) => RetailVariant.updateOne({ _id: variant.id, product: product._id }, {
      $set: { title: variant.title, sku: variant.sku, barcode: variant.barcode, price: variant.price, compareAtPrice: variant.compareAtPrice, unitCost: variant.unitCost, unitCostSource: 'manual', unitCostStatus: variant.unitCost == null ? 'review' : 'complete', inventoryPolicy: variant.inventoryPolicy, tracked: variant.tracked, isActive: status === 'active', barcodeSyncStatus: 'pending', barcodeSyncError: '' },
    })));
    return res.status(202).json({ success: true, data: { productId: product._id, status, task: publicTask(task), message: 'Saved locally. Shopify is updating in the background.' } });
  }

  product.set({ ...productInput, isActive: status === 'active' });
  await product.save();
  await Promise.all(variants.map((variant) => RetailVariant.updateOne({ _id: variant.id, product: product._id }, {
    $set: { title: variant.title, sku: variant.sku, barcode: variant.barcode, price: variant.price, compareAtPrice: variant.compareAtPrice, unitCost: variant.unitCost, unitCostSource: 'manual', unitCostStatus: variant.unitCost == null ? 'review' : 'complete', inventoryPolicy: variant.inventoryPolicy, tracked: variant.tracked, isActive: status === 'active' },
  })));
  res.json({ success: true, data: { productId: product._id, status } });
};

export const editRetailBarcode = async (req, res) => {
  const barcode = String(req.body?.barcode || '').trim();
  if (barcode.length > 80) throw fail('Barcode must be 80 characters or fewer.');
  const variant = await RetailVariant.findById(req.params.variantId);
  if (!variant) throw fail('Retail variant not found.', 404);
  const connectedShopify = variant.shopifyVariantId && await ShopifyConnection.exists({ status: 'connected' });
  const result = connectedShopify
    ? await (async () => {
      const task = await enqueueShopifyTask('barcode-update', { variantId: String(variant._id), barcode });
      variant.barcode = barcode;
      variant.barcodeSyncStatus = 'pending';
      variant.barcodeSyncError = '';
      await variant.save();
      return { _id: variant._id, barcode, barcodeSyncStatus: 'pending', task: publicTask(task) };
    })()
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
