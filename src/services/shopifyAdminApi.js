import { checkShopifyTask } from './shopifyTaskContext.js';
import crypto from 'crypto';
import mongoose from 'mongoose';
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
  const credentialHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
  const key = `${shopDomain}:${clientId}:${credentialHash}`;
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
  await checkShopifyTask();
  const { connection, accessToken } = await getShopifyConnectionSecrets();
  await checkShopifyTask();
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

export const importShopifyCatalog = async ({ maxPages = 100, onProgress = null, shouldCancel = null } = {}) => {
  const connection = await ShopifyConnection.findOne({ status: 'connected' }).lean();
  if (!connection) throw Object.assign(new Error('Shopify is not connected.'), { statusCode: 409 });
  const mappingByLocation = new Map(
    (connection.locationMappings || []).map((mapping) => [mapping.shopifyLocationId, mapping.outlet]),
  );
  let after = null;
  let productsWritten = 0;
  let variantsWritten = 0;
  let pages = 0;
  const reportProgress = async (stage) => {
    if (typeof onProgress === 'function') await onProgress({ productsWritten, variantsWritten, pages, stage });
  };
  const throwIfCancelled = async () => {
    await checkShopifyTask();
    if (typeof shouldCancel === 'function' && await shouldCancel()) {
      throw Object.assign(new Error('Shopify catalog sync cancelled.'), { code: 'SHOPIFY_TASK_CANCELLED' });
    }
  };
  await reportProgress('Connecting to Shopify…');
  do {
    await throwIfCancelled();
    const { data } = await shopifyGraphql(productQuery, { after });
    const result = data?.products;
    if (!result) throw new Error('Shopify did not return a products connection.');
    await reportProgress(`Reading Shopify product page ${pages + 1}…`);
    for (const product of result.nodes || []) {
      await throwIfCancelled();
      // Keep each GraphQL request comfortably below Shopify's 1,000-point
      // single-query ceiling. Variants are paged separately and accumulated
      // before upserting so exact-SKU matching still sees the complete set.
      const completeProduct = { ...product, variants: { ...product.variants, nodes: [...(product.variants?.nodes || [])] } };
      let variantAfter = product.variants?.pageInfo?.hasNextPage ? product.variants.pageInfo.endCursor : null;
      while (variantAfter) {
        await throwIfCancelled();
        const { data: variantData } = await shopifyGraphql(productVariantsQuery, { id: product.id, after: variantAfter });
        const variantPage = variantData?.product?.variants;
        if (!variantPage) throw new Error(`Shopify did not return variants for product ${product.id}.`);
        completeProduct.variants.nodes.push(...(variantPage.nodes || []));
        variantAfter = variantPage.pageInfo?.hasNextPage ? variantPage.pageInfo.endCursor : null;
      }
      const written = await upsertShopifyProduct(completeProduct, mappingByLocation);
      productsWritten += 1;
      variantsWritten += written.variantsWritten;
      await reportProgress(`Imported ${product.title || 'Shopify product'}…`);
    }
    pages += 1;
    await reportProgress(`Completed Shopify page ${pages}…`);
    after = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
  } while (after && pages < maxPages);

  await throwIfCancelled();

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
    if (!payload?.productVariants?.[0]?.id) throw new Error('Shopify did not confirm the barcode update.');
    const savedBarcode = payload.productVariants[0].barcode || '';
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

export const updateShopifyRetailProduct = async (productId, productInput, variantInputs) => {
  const product = await RetailProduct.findById(productId).lean();
  if (!product) throw Object.assign(new Error('Retail product not found.'), { statusCode: 404 });
  const variants = await RetailVariant.find({ product: product._id, shopifyVariantId: { $exists: true, $ne: '' } }).lean();
  if (!product.shopifyProductId || variants.length !== variantInputs.length) {
    throw Object.assign(new Error('The Shopify variant list changed. Refresh the catalog and try again.'), { statusCode: 409 });
  }
  const variantsById = new Map(variants.map((variant) => [String(variant._id), variant]));
  const remoteIds = new Set(variants.map((variant) => variant.shopifyVariantId));
  const normalizedVariants = variantInputs.map((input) => {
    const current = variantsById.get(String(input.id));
    if (!current || !remoteIds.has(current.shopifyVariantId)) {
      throw Object.assign(new Error('One or more variants no longer belong to this Shopify product.'), { statusCode: 409 });
    }
    return { current, input };
  });
  const mutation = `mutation UpdateBoutiqueProduct($input: ProductUpdateInput!, $productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productUpdate(product: $input) {
      product { id status }
      userErrors { field message }
    }
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }`;
  const { data } = await shopifyGraphql(mutation, {
    input: {
      id: product.shopifyProductId,
      title: productInput.title,
      descriptionHtml: productInput.description,
      productType: productInput.productType,
      vendor: productInput.vendor,
      tags: productInput.tags,
      handle: productInput.handle,
      status: productInput.status.toUpperCase(),
    },
    productId: product.shopifyProductId,
    variants: normalizedVariants.map(({ current, input }) => ({
      id: current.shopifyVariantId,
      price: String(input.price),
      compareAtPrice: input.compareAtPrice === '' || input.compareAtPrice == null ? null : String(input.compareAtPrice),
      barcode: input.barcode || null,
      inventoryItem: { sku: input.sku, tracked: input.tracked, cost: input.unitCost == null ? null : String(input.unitCost) },
      inventoryPolicy: input.inventoryPolicy,
      optionValues: (input.options || []).filter((option) => option.name && option.value)
        .map((option) => ({ optionName: option.name, name: option.value })),
    })),
  });
  const productErrors = data?.productUpdate?.userErrors || [];
  const variantErrors = data?.productVariantsBulkUpdate?.userErrors || [];
  if (productErrors.length || variantErrors.length || !data?.productUpdate?.product || !data?.productVariantsBulkUpdate?.productVariants) {
    const messages = [...productErrors, ...variantErrors].map((entry) => entry.message);
    throw Object.assign(new Error(messages.join('; ') || 'Shopify did not confirm the product update.'), { statusCode: 422 });
  }
  await syncShopifyProductById(product.shopifyProductId);
  await Promise.all(normalizedVariants.map(({ current, input }) => RetailVariant.updateOne({ _id: current._id }, {
    $set: { unitCost: input.unitCost, unitCostSource: 'manual', unitCostStatus: input.unitCost == null ? 'review' : 'complete' },
  })));
  return { productId: product._id, shopifyProductId: product.shopifyProductId, status: productInput.status };
};

export const adjustShopifyInventory = async ({ inventoryItemId, locationId, delta, idempotencyKey, referenceId }) => {
  const safeDelta = Number(delta);
  if (!inventoryItemId || !locationId || !Number.isInteger(safeDelta) || safeDelta === 0 || !idempotencyKey) {
    throw Object.assign(new Error('Shopify inventory adjustment is missing an item, location, integer delta, or idempotency key.'), { statusCode: 400 });
  }
  const key = /^[a-f\d]{64}$/i.test(String(idempotencyKey))
    ? String(idempotencyKey)
    : crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex');
  const currentInventoryQuery = `query BoutiqueCurrentInventory($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  }`;
  const { data: inventoryData } = await shopifyGraphql(currentInventoryQuery, { inventoryItemId, locationId });
  const currentAvailable = Number(inventoryData?.inventoryItem?.inventoryLevel?.quantities?.find((item) => item.name === 'available')?.quantity);
  if (!Number.isInteger(currentAvailable)) {
    throw Object.assign(new Error('Shopify has no available inventory level for this item at the mapped location.'), { statusCode: 409, permanent: true });
  }
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
      // Supply Shopify's latest quantity explicitly. API 2026-04+ requires
      // this field, and the compare-and-swap check protects concurrent sales.
      changes: [{ inventoryItemId, locationId, delta: safeDelta, changeFromQuantity: currentAvailable }],
    },
  });
  const result = data?.inventoryAdjustQuantities;
  if (result?.userErrors?.length || !result?.inventoryAdjustmentGroup?.id) {
    const userErrors = result?.userErrors || [];
    const message = userErrors.map((entry) => entry.message).join('; ') || 'Shopify did not apply the inventory adjustment.';
    const staleQuantity = userErrors.some((entry) => /change.?from.?quantity.*stale|stale.*quantity/i.test(entry.message || ''));
    throw Object.assign(new Error(message), { statusCode: 409, permanent: !staleQuantity });
  }
  return result.inventoryAdjustmentGroup;
};

export const getRetailCatalogFilterOptions = async ({ includeInactive = false } = {}) => {
  const [productOptionDocs, optionRows] = await Promise.all([
    RetailProduct.find(includeInactive ? { deletedAt: null } : { isActive: true, deletedAt: null }).select('productType vendor tags').lean(),
    RetailVariant.aggregate([
      { $match: includeInactive ? { deletedAt: null } : { isActive: true, deletedAt: null } },
      { $unwind: '$options' },
      { $match: { 'options.value': { $nin: ['', 'Default Title', null] } } },
      { $group: { _id: { name: '$options.name', value: '$options.value' } } },
    ]),
  ]);
  const optionPairs = optionRows.map((row) => ({ name: row._id.name || '', value: row._id.value || '' }));
  return {
    types: [...new Set(productOptionDocs.map((product) => product.productType).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    vendors: [...new Set(productOptionDocs.map((product) => product.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    tags: [...new Set(productOptionDocs.flatMap((product) => product.tags || []).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    optionValues: [...new Set(optionPairs.map((option) => option.value))].sort((a, b) => a.localeCompare(b)),
    sizes: [...new Set(optionPairs.filter((option) => /size/i.test(option.name)).map((option) => option.value))].sort((a, b) => a.localeCompare(b)),
    colors: [...new Set(optionPairs.filter((option) => /colou?r/i.test(option.name)).map((option) => option.value))].sort((a, b) => a.localeCompare(b)),
  };
};

export const searchRetailCatalog = async ({ search = '', outletId = null, limit = 50, page = 1, includeInactive = false, status = 'all', source = 'all', type = '', vendor = '', tag = '', size = '', color = '', optionValue = '', stock = 'all', tracked = 'all', barcode = 'all', minPrice, maxPrice, sort = 'name', withFilterOptions = false, summary = false } = {}) => {
  const query = includeInactive ? { deletedAt: null } : { isActive: true, deletedAt: null };
  const outletObjectId = outletId && mongoose.isValidObjectId(outletId) ? new mongoose.Types.ObjectId(outletId) : null;
  const productFilter = { deletedAt: null };
  if (status !== 'all') productFilter.status = status;
  if (source !== 'all') productFilter.catalogSource = source;
  if (type) productFilter.productType = type;
  if (vendor) productFilter.vendor = vendor;
  if (tag) productFilter.tags = tag;
  if (!includeInactive) productFilter.isActive = true;
  if (outletObjectId && !includeInactive) query.inventoryByLocation = { $elemMatch: { outlet: outletObjectId } };
  if (source !== 'all') query.catalogSource = source;
  const optionConstraints = [
    ...(optionValue ? [{ $elemMatch: { value: optionValue } }] : []),
    ...(size ? [{ $elemMatch: { name: /size/i, value: size } }] : []),
    ...(color ? [{ $elemMatch: { name: /colou?r/i, value: color } }] : []),
  ];
  if (optionConstraints.length === 1) query.options = optionConstraints[0];
  else if (optionConstraints.length > 1) query.options = { $all: optionConstraints };
  if (tracked !== 'all') query.tracked = tracked === 'yes';
  if (barcode === 'has') query.barcode = { $nin: ['', null] };
  if (barcode === 'missing') query.barcode = { $in: ['', null] };
  if (minPrice !== undefined && minPrice !== '' && Number.isFinite(Number(minPrice))) query.price = { ...(query.price || {}), $gte: Number(minPrice) };
  if (maxPrice !== undefined && maxPrice !== '' && Number.isFinite(Number(maxPrice))) query.price = { ...(query.price || {}), $lte: Number(maxPrice) };
  // Keep filtering, joining, counting and paging inside MongoDB in one trip.
  const pipeline = [{ $match: query }, {
    $lookup: {
      from: RetailProduct.collection.name, localField: 'product', foreignField: '_id', as: 'product',
      pipeline: [{ $match: productFilter }, { $project: {
        title: 1, handle: 1, ...(summary ? {} : { description: 1 }), productType: 1, vendor: 1,
        tags: 1, imageUrl: 1, status: 1, isActive: 1,
      } }],
    },
  }, { $unwind: '$product' }];
  if (search.trim()) {
    const regex = new RegExp(search.trim().slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    pipeline.push({ $match: { $or: ['sku', 'barcode', 'title', 'options.value', 'product.title', 'product.productType', 'product.vendor', 'product.tags'].map((field) => ({ [field]: regex })) } });
  }
  const locations = { $ifNull: ['$inventoryByLocation', []] };
  const selectedLocations = { $filter: { input: locations, as: 'location', cond: { $eq: ['$$location.outlet', outletObjectId] } } };
  // Preserve the selected stock location used by POS inventory movements.
  const firstLocationValue = (field, fallback) => ({ $ifNull: [{ $arrayElemAt: [{ $map: {
    input: selectedLocations, as: 'location', in: `$$location.${field}`,
  } }, 0] }, fallback] });
  pipeline.push({ $set: {
    available: outletObjectId ? firstLocationValue('available', 0)
      : { $sum: { $map: { input: locations, as: 'location', in: '$$location.available' } } },
    selectedLocationId: firstLocationValue('shopifyLocationId', ''),
  } });
  if (stock === 'in') pipeline.push({ $match: { available: { $gt: 0 } } });
  if (stock === 'out') pipeline.push({ $match: { available: { $lte: 0 } } });
  const pageSize = Math.max(1, Math.min(250, Math.floor(Number(limit) || 50)));
  const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const sortBy = {
    stockAsc: { available: 1, 'product.title': 1, _id: 1 },
    stockDesc: { available: -1, 'product.title': 1, _id: 1 },
    priceAsc: { price: 1, 'product.title': 1, _id: 1 },
    priceDesc: { price: -1, 'product.title': 1, _id: 1 },
    name: { 'product.title': 1, title: 1, _id: 1 },
  }[sort] || { 'product.title': 1, title: 1, _id: 1 };
  const rows = (pageNumber) => [
    { $sort: sortBy }, { $skip: (pageNumber - 1) * pageSize }, { $limit: pageSize },
    ...(summary ? [{ $project: { _id: 1, product: 1, title: 1, options: 1, sku: 1, barcode: 1, price: 1, available: 1, tracked: 1, catalogSource: 1, shopifyVariantId: 1, selectedLocationId: 1 } }] : []),
  ];
  const [result, filterOptions] = await Promise.all([
    RetailVariant.aggregate([...pipeline, { $facet: { items: rows(requestedPage), totals: [{ $count: 'count' }] } }]).collation({ locale: 'en', strength: 2 }),
    withFilterOptions ? getRetailCatalogFilterOptions({ includeInactive }) : undefined,
  ]);
  const total = result[0]?.totals[0]?.count || 0;
  const totalPages = Math.ceil(total / pageSize);
  const pageNumber = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const items = pageNumber !== requestedPage && total
    ? await RetailVariant.aggregate([...pipeline, ...rows(pageNumber)]).collation({ locale: 'en', strength: 2 })
    : result[0]?.items || [];
  return { items, total, page: pageNumber, pageSize, totalPages, filterOptions };
};
