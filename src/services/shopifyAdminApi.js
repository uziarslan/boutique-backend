import crypto from 'crypto';
import { env } from '../config/env.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import RetailProduct from '../models/RetailProduct.js';
import RetailVariant from '../models/RetailVariant.js';
import { decryptShopifySecret } from '../utils/shopifySecret.js';

export const normalizeShopDomain = (value) => {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : '';
};

const connectionWithSecrets = async () => ShopifyConnection.findOne({ status: { $ne: 'disconnected' } })
  .select('+accessTokenEncrypted +clientIdEncrypted +clientSecretEncrypted')
  .lean();

const accessTokenCache = new Map();

const exchangeClientCredentials = async ({ shopDomain, clientId, clientSecret }) => {
  const key = `${shopDomain}:${clientId}`;
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Shopify credential exchange failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 500)}`);
  }
  const expiresIn = Math.max(60, Number(body.expires_in) || 86_400);
  accessTokenCache.set(key, { accessToken: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return body.access_token;
};

export const getShopifyConnectionSecrets = async () => {
  const connection = await connectionWithSecrets();
  if (!connection) throw Object.assign(new Error('Shopify is not connected.'), { statusCode: 409 });
  const clientId = decryptShopifySecret(connection.clientIdEncrypted);
  const clientSecret = decryptShopifySecret(connection.clientSecretEncrypted);
  let accessToken = '';
  if (clientId && clientSecret) {
    accessToken = await exchangeClientCredentials({ shopDomain: connection.shopDomain, clientId, clientSecret });
  } else {
    accessToken = decryptShopifySecret(connection.accessTokenEncrypted);
  }
  if (!accessToken || !clientSecret) {
    throw Object.assign(new Error('Shopify credentials cannot be decrypted. Check SHOPIFY_ENCRYPTION_KEY.'), { statusCode: 503 });
  }
  return { connection, accessToken, clientSecret };
};

export const shopifyGraphql = async (query, variables = {}) => {
  const { connection, accessToken } = await getShopifyConnectionSecrets();
  const apiVersion = /^\d{4}-\d{2}$/.test(connection.apiVersion || '')
    ? connection.apiVersion
    : env.SHOPIFY_API_VERSION;
  const response = await fetch(`https://${connection.shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Shopify Admin API returned HTTP ${response.status}: ${JSON.stringify(body.errors || body).slice(0, 700)}`);
  }
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((entry) => entry.message).join('; ').slice(0, 700)}`);
  }
  return { data: body.data, connection };
};

const graphQlWithCredentials = async ({ shopDomain, accessToken }, query, variables = {}) => {
  const apiVersion = env.SHOPIFY_API_VERSION;
  const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Shopify Admin API returned HTTP ${response.status}: ${JSON.stringify(body.errors || body).slice(0, 700)}`);
  }
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((entry) => entry.message).join('; ').slice(0, 700)}`);
  }
  return body.data;
};

export const verifyShopifyCredentials = async ({ shopDomain, clientId, clientSecret }) => {
  const domain = normalizeShopDomain(shopDomain);
  if (!domain || !String(clientId || '').trim() || !String(clientSecret || '').trim()) {
    throw Object.assign(new Error('Enter a valid .myshopify.com domain, app client ID, and client secret.'), { statusCode: 400 });
  }
  const accessToken = await exchangeClientCredentials({ shopDomain: domain, clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() });
  const data = await graphQlWithCredentials({ shopDomain: domain, accessToken: String(accessToken).trim() },
    'query BoutiqueShopCheck { shop { name myshopifyDomain currencyCode } }');
  if (!data?.shop?.myshopifyDomain) throw new Error('Shopify did not return shop details.');
  return data.shop;
};

export const ensureShopifyWebhookSubscriptions = async () => {
  const base = String(env.SHOPIFY_WEBHOOK_BASE_URL || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) {
    throw Object.assign(new Error('Set SHOPIFY_WEBHOOK_BASE_URL to the public HTTPS API origin before registering Shopify webhooks.'), { statusCode: 503 });
  }
  const uri = `${base}/api/shopify/webhooks`;
  const { data: current } = await shopifyGraphql(`query BoutiqueWebhookSubscriptions {
    webhookSubscriptions(first: 250) { nodes { id topic uri } }
  }`);
  const currentByTopic = new Map((current?.webhookSubscriptions?.nodes || [])
    .filter((item) => item.uri === uri).map((item) => [item.topic, item.id]));
  const topics = [
    'PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE',
    'INVENTORY_LEVELS_UPDATE', 'ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE',
  ];
  const subscriptions = [];
  for (const topic of topics) {
    if (currentByTopic.has(topic)) {
      subscriptions.push({ topic, subscriptionId: currentByTopic.get(topic) });
      continue;
    }
    const mutation = `mutation CreateBoutiqueWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id topic uri }
        userErrors { field message }
      }
    }`;
    const { data } = await shopifyGraphql(mutation, {
      topic,
      webhookSubscription: { uri, format: 'JSON' },
    });
    const result = data?.webhookSubscriptionCreate;
    if (result?.userErrors?.length || !result?.webhookSubscription?.id) {
      const messages = result?.userErrors?.map((entry) => entry.message).join('; ') || 'Shopify did not create the subscription.';
      throw new Error(`${topic}: ${messages}`);
    }
    subscriptions.push({ topic, subscriptionId: result.webhookSubscription.id });
  }
  await ShopifyConnection.updateOne({}, { $set: { webhookSubscriptions: subscriptions } });
  return subscriptions;
};

const productQuery = `query BoutiqueProducts($after: String) {
  products(first: 5, after: $after, sortKey: UPDATED_AT) {
    nodes {
      id title handle descriptionHtml productType vendor tags status updatedAt
      featuredImage { url }
      variants(first: 10) {
        nodes {
          id title sku barcode price compareAtPrice selectedOptions { name value }
          inventoryItem {
            id tracked unitCost { amount }
            inventoryLevels(first: 10) {
              nodes {
                updatedAt
                location { id name }
                quantities(names: ["available", "on_hand"]) { name quantity }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const productVariantsQuery = `query BoutiqueProductVariants($id: ID!, $after: String) {
  product(id: $id) {
    id title handle descriptionHtml productType vendor tags status updatedAt
    featuredImage { url }
    variants(first: 10, after: $after) {
      nodes {
        id title sku barcode price compareAtPrice selectedOptions { name value }
        inventoryItem {
          id tracked unitCost { amount }
          inventoryLevels(first: 10) {
            nodes {
              updatedAt
              location { id name }
              quantities(names: ["available", "on_hand"]) { name quantity }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const plainHtml = (value = '') => String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const amount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const qtyByName = (quantities, name) => Number(quantities?.find((q) => q.name === name)?.quantity || 0);

const upsertShopifyProduct = async (rawProduct, mappingByLocation) => {
  const rawVariants = rawProduct.variants?.nodes || [];
  let existingProduct = await RetailProduct.findOne({ shopifyProductId: rawProduct.id }).select('_id').lean();
  let matchedProductId = null;
  let matchedManualVariantsBySku = new Map();

  // When the whole active manual variant set has unique SKUs that exactly match
  // Shopify, attach the Shopify IDs to those existing records. This preserves
  // BOM and production references created before the Shopify connection.
  const remoteSkus = rawVariants.map((variant) => String(variant.sku || '').trim());
  const canMatchBySku = !existingProduct && remoteSkus.length > 0
    && remoteSkus.every(Boolean) && new Set(remoteSkus).size === remoteSkus.length;
  if (canMatchBySku) {
    const localVariants = await RetailVariant.find({
      catalogSource: 'manual',
      sku: { $in: remoteSkus },
      isActive: true,
      $or: [{ shopifyVariantId: { $exists: false } }, { shopifyVariantId: '' }],
    }).select('_id product sku unitCostSource').lean();
    const productIds = [...new Set(localVariants.map((variant) => String(variant.product)))];
    if (localVariants.length === remoteSkus.length && productIds.length === 1) {
      const activeLocalCount = await RetailVariant.countDocuments({ product: productIds[0], isActive: true });
      const localSkuSet = new Set(localVariants.map((variant) => variant.sku));
      if (activeLocalCount === remoteSkus.length && remoteSkus.every((sku) => localSkuSet.has(sku))) {
        matchedProductId = productIds[0];
        matchedManualVariantsBySku = new Map(localVariants.map((variant) => [variant.sku, variant]));
      }
    }
  }

  const product = await RetailProduct.findOneAndUpdate(
    existingProduct ? { _id: existingProduct._id } : matchedProductId ? { _id: matchedProductId } : { shopifyProductId: rawProduct.id },
    {
      $set: {
        shopifyProductId: rawProduct.id,
        catalogSource: 'shopify',
        title: rawProduct.title || 'Untitled product',
        handle: rawProduct.handle || '',
        description: plainHtml(rawProduct.descriptionHtml),
        productType: rawProduct.productType || '',
        vendor: rawProduct.vendor || '',
        tags: rawProduct.tags || [],
        imageUrl: rawProduct.featuredImage?.url || '',
        status: String(rawProduct.status || 'ACTIVE').toLowerCase(),
        isActive: String(rawProduct.status || '').toUpperCase() === 'ACTIVE',
        shopifyUpdatedAt: rawProduct.updatedAt ? new Date(rawProduct.updatedAt) : null,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  let variantsWritten = 0;
  for (const rawVariant of rawVariants) {
    const locations = (rawVariant.inventoryItem?.inventoryLevels?.nodes || []).map((level) => ({
      shopifyLocationId: level.location.id,
      outlet: mappingByLocation.get(level.location.id) || null,
      available: qtyByName(level.quantities, 'available'),
      onHand: qtyByName(level.quantities, 'on_hand'),
      updatedAt: level.updatedAt ? new Date(level.updatedAt) : rawProduct.updatedAt ? new Date(rawProduct.updatedAt) : new Date(),
    }));
    const existingVariant = await RetailVariant.findOne({ shopifyVariantId: rawVariant.id }).select('_id unitCostSource').lean();
    const matchedManualVariant = matchedManualVariantsBySku.get(String(rawVariant.sku || '').trim());
    const variantRecord = existingVariant || matchedManualVariant;
    const variantUpdate = {
      product: product._id,
      catalogSource: 'shopify',
      shopifyProductId: rawProduct.id,
      shopifyInventoryItemId: rawVariant.inventoryItem?.id || '',
      title: rawVariant.title || 'Default Title',
      options: rawVariant.selectedOptions || [],
      sku: rawVariant.sku || '',
      barcode: rawVariant.barcode || '',
      price: amount(rawVariant.price),
      compareAtPrice: rawVariant.compareAtPrice == null ? null : amount(rawVariant.compareAtPrice),
      tracked: rawVariant.inventoryItem?.tracked !== false,
      inventoryByLocation: locations,
      shopifyUpdatedAt: rawProduct.updatedAt ? new Date(rawProduct.updatedAt) : null,
      isActive: product.isActive,
      barcodeSyncStatus: 'synced',
      barcodeSyncError: '',
    };
    if (variantRecord?.unitCostSource !== 'production') {
      variantUpdate.unitCost = rawVariant.inventoryItem?.unitCost?.amount == null
        ? null
        : amount(rawVariant.inventoryItem.unitCost.amount);
      variantUpdate.unitCostSource = 'shopify';
      variantUpdate.unitCostStatus = variantUpdate.unitCost == null ? 'review' : 'complete';
    }
    await RetailVariant.findOneAndUpdate(
      variantRecord ? { _id: variantRecord._id } : { shopifyVariantId: rawVariant.id },
      { $set: variantUpdate },
      { upsert: true, setDefaultsOnInsert: true },
    );
    variantsWritten += 1;
  }
  return { product: product._id, variantsWritten };
};

export const fetchShopifyLocations = async () => {
  const { data } = await shopifyGraphql(`query BoutiqueLocations($after: String) {
    locations(first: 250, after: $after, includeInactive: false) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  return data?.locations?.nodes || [];
};

export const importShopifyCatalog = async ({ maxPages = 100 } = {}) => {
  const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
  if (!connection) throw Object.assign(new Error('Shopify is not connected.'), { statusCode: 409 });
  const mappingByLocation = new Map(
    (connection.locationMappings || []).map((mapping) => [mapping.shopifyLocationId, mapping.outlet]),
  );
  let after = null;
  let productsWritten = 0;
  let variantsWritten = 0;
  let pages = 0;
  do {
    const { data } = await shopifyGraphql(productQuery, { after });
    const result = data?.products;
    if (!result) throw new Error('Shopify did not return a products connection.');
    for (const product of result.nodes || []) {
      // Keep each GraphQL request comfortably below Shopify's 1,000-point
      // single-query ceiling. Variants are paged separately and accumulated
      // before upserting so exact-SKU matching still sees the complete set.
      const completeProduct = { ...product, variants: { ...product.variants, nodes: [...(product.variants?.nodes || [])] } };
      let variantAfter = product.variants?.pageInfo?.hasNextPage ? product.variants.pageInfo.endCursor : null;
      while (variantAfter) {
        const { data: variantData } = await shopifyGraphql(productVariantsQuery, { id: product.id, after: variantAfter });
        const variantPage = variantData?.product?.variants;
        if (!variantPage) throw new Error(`Shopify did not return variants for product ${product.id}.`);
        completeProduct.variants.nodes.push(...(variantPage.nodes || []));
        variantAfter = variantPage.pageInfo?.hasNextPage ? variantPage.pageInfo.endCursor : null;
      }
      const written = await upsertShopifyProduct(completeProduct, mappingByLocation);
      productsWritten += 1;
      variantsWritten += written.variantsWritten;
    }
    pages += 1;
    after = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
  } while (after && pages < maxPages);

  if (after) throw new Error(`Catalog import stopped at ${maxPages} pages. Run another sync to continue.`);
  await ShopifyConnection.updateOne({}, { $set: { lastCatalogSyncAt: new Date(), lastInventorySyncAt: new Date(), lastError: '' } });
  return { productsWritten, variantsWritten, pages };
};

export const syncShopifyProductById = async (shopifyProductId) => {
  const { data } = await shopifyGraphql(`query BoutiqueProduct($id: ID!) {
    product(id: $id) {
      id title handle descriptionHtml productType vendor tags status updatedAt
      featuredImage { url }
      variants(first: 10) {
        nodes { id title sku barcode price compareAtPrice selectedOptions { name value }
          inventoryItem { id tracked unitCost { amount }
            inventoryLevels(first: 10) { nodes { updatedAt location { id name } quantities(names: ["available", "on_hand"]) { name quantity } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`, { id: shopifyProductId });
  const rawProduct = data?.product;
  if (!rawProduct) return null;
  rawProduct.variants.nodes = [...(rawProduct.variants?.nodes || [])];
  let variantAfter = rawProduct.variants?.pageInfo?.hasNextPage ? rawProduct.variants.pageInfo.endCursor : null;
  while (variantAfter) {
    const { data: variantData } = await shopifyGraphql(productVariantsQuery, { id: shopifyProductId, after: variantAfter });
    const variantPage = variantData?.product?.variants;
    if (!variantPage) throw new Error(`Shopify did not return variants for product ${shopifyProductId}.`);
    rawProduct.variants.nodes.push(...(variantPage.nodes || []));
    variantAfter = variantPage.pageInfo?.hasNextPage ? variantPage.pageInfo.endCursor : null;
  }
  const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
  const mappings = new Map((connection?.locationMappings || []).map((mapping) => [mapping.shopifyLocationId, mapping.outlet]));
  return upsertShopifyProduct(rawProduct, mappings);
};

export const updateShopifyVariantBarcode = async (variantId, barcode) => {
  const variant = await RetailVariant.findById(variantId).lean();
  if (!variant) throw Object.assign(new Error('Retail variant not found.'), { statusCode: 404 });
  await RetailVariant.updateOne({ _id: variant._id }, { $set: { barcodeSyncStatus: 'pending', barcodeSyncError: '' } });
  try {
    const mutation = `mutation SetVariantBarcode($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id barcode }
        userErrors { field message }
      }
    }`;
    const { data } = await shopifyGraphql(mutation, {
      productId: variant.shopifyProductId,
      variants: [{ id: variant.shopifyVariantId, barcode: String(barcode || '').trim() || null }],
    });
    const payload = data?.productVariantsBulkUpdate;
    if (payload?.userErrors?.length) throw new Error(payload.userErrors.map((e) => e.message).join('; '));
    const savedBarcode = payload?.productVariants?.[0]?.barcode || '';
    await RetailVariant.updateOne({ _id: variant._id }, {
      $set: { barcode: savedBarcode, barcodeSyncStatus: 'synced', barcodeSyncError: '' },
    });
    return { _id: variant._id, barcode: savedBarcode, barcodeSyncStatus: 'synced' };
  } catch (error) {
    await RetailVariant.updateOne({ _id: variant._id }, {
      $set: { barcodeSyncStatus: 'failed', barcodeSyncError: error.message.slice(0, 500) },
    });
    throw error;
  }
};

export const adjustShopifyInventory = async ({ inventoryItemId, locationId, delta, idempotencyKey, referenceId }) => {
  const safeDelta = Number(delta);
  if (!inventoryItemId || !locationId || !Number.isInteger(safeDelta) || safeDelta === 0 || !idempotencyKey) {
    throw Object.assign(new Error('Shopify inventory adjustment is missing an item, location, integer delta, or idempotency key.'), { statusCode: 400 });
  }
  const key = /^[a-f\d]{64}$/i.test(String(idempotencyKey))
    ? String(idempotencyKey)
    : crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex');
  const mutation = `mutation BoutiqueInventoryAdjustment($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: "${key}") {
      inventoryAdjustmentGroup { id createdAt reason referenceDocumentUri changes { name delta } }
      userErrors { field message }
    }
  }`;
  const { data } = await shopifyGraphql(mutation, {
    input: {
      name: 'available',
      reason: 'correction',
      referenceDocumentUri: `boutique://inventory-movement/${encodeURIComponent(referenceId || key)}`,
      changes: [{ inventoryItemId, locationId, delta: safeDelta }],
    },
  });
  const result = data?.inventoryAdjustQuantities;
  if (result?.userErrors?.length || !result?.inventoryAdjustmentGroup?.id) {
    const message = result?.userErrors?.map((entry) => entry.message).join('; ') || 'Shopify did not apply the inventory adjustment.';
    throw Object.assign(new Error(message), { statusCode: 409, permanent: true });
  }
  return result.inventoryAdjustmentGroup;
};

export const searchRetailCatalog = async ({ search = '', outletId = null, limit = 100, page = 1 } = {}) => {
  const query = { isActive: true };
  if (search.trim()) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const products = await RetailProduct.find({ isActive: true, $or: [{ title: regex }, { productType: regex }, { vendor: regex }] }).select('_id').limit(500).lean();
    query.$or = [{ sku: regex }, { barcode: regex }, { title: regex }, { product: { $in: products.map((product) => product._id) } }];
  }
  if (outletId) query.inventoryByLocation = { $elemMatch: { outlet: outletId } };
  const pageSize = Math.max(1, Math.min(250, Number(limit) || 100));
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
  const [variants, total] = await Promise.all([RetailVariant.find(query)
    .populate('product', 'title productType vendor imageUrl status')
    .sort({ sku: 1, title: 1 })
    .skip((pageNumber - 1) * pageSize)
    .limit(pageSize)
    .lean(), RetailVariant.countDocuments(query)]);
  const items = variants.map((variant) => {
    const stock = outletId
      ? variant.inventoryByLocation.find((entry) => String(entry.outlet) === String(outletId))
      : null;
    return { ...variant, available: stock?.available ?? 0, selectedLocationId: stock?.shopifyLocationId || '' };
  });
  return { items, total, page: pageNumber, pageSize, totalPages: Math.ceil(total / pageSize) };
};
