import Product from '../models/Product.js';
import Asset from '../models/Asset.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetMovement from '../models/AssetMovement.js';
import StockItem from '../models/StockItem.js';
import StockMovement from '../models/StockMovement.js';
import JournalEntry from '../models/JournalEntry.js';
import { allocatePurchaseGoods, postPurchase } from '../accounting/journalEngine.js';
import { isAssetAuditEnabledForOutlet } from './assetFeature.service.js';
import { recomputeAllPrepCosts } from '../controllers/prepRecipe.controller.js';
import { dropLegacyStockIndexIfPresent } from '../utils/stockIndexes.js';
import { normalizeLegacyProductPriceHistory } from '../utils/productPriceHistory.js';
import { validatePurchaseLineInputs } from '../utils/purchaseLineValidation.js';
import logger from '../utils/logger.js';

const round4 = (value) => Number((Number(value) || 0).toFixed(4));

export const aggregatePurchaseLines = (lines = []) => {
  const map = new Map();
  for (const line of lines) {
    if (line.accountingTreatment && line.accountingTreatment !== 'inventory') continue;
    const product = line.product?._id || line.product;
    if (!product || Number(line.qty) <= 0) continue;
    const key = product.toString();
    const packSize = Math.max(1, Number(line.packSize) || 1);
    const units = Number(line.qty) * packSize;
    const spend = Number(line.lineTotal ?? (Number(line.qty) * Number(line.unitPrice))) || 0;
    const entryMode = line.entryMode === 'pack' || packSize > 1 ? 'pack' : 'loose';
    const current = map.get(key) || {
      product, units: 0, spend: 0, packSize, entryMode,
    };
    current.units += units;
    current.spend += spend;
    if (entryMode === 'pack') {
      current.entryMode = 'pack';
      current.packSize = packSize;
    }
    map.set(key, current);
  }
  return map;
};

const createPurchaseAssets = async (purchase, journalEntry, userId, undo) => {
  const allocations = allocatePurchaseGoods(purchase)
    .filter((allocation) => allocation.treatment === 'asset');
  if (!allocations.length) return [];

  const categoryIds = allocations
    .map(({ line }) => line.assetCategory?._id || line.assetCategory)
    .filter(Boolean);
  const categories = await AssetCategory.find({
    _id: { $in: categoryIds },
    isActive: true,
  }).lean();
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
  const assets = [];

  for (const { line, amount } of allocations) {
    const categoryId = line.assetCategory?._id || line.assetCategory;
    const category = categoryMap.get(String(categoryId || ''));
    if (!category || !category.accounts?.asset) {
      throw new Error(`Asset category for "${line.description || 'asset line'}" is invalid or no longer active.`);
    }
    line.assetAccount = category.accounts.asset;
    const quantity = Number(line.qty) || 0;
    if (quantity <= 0) throw new Error('Asset quantity must be greater than zero.');
    if (category.trackingMode === 'serialized' && !Number.isInteger(quantity)) {
      throw new Error(`"${line.description || category.name}" requires a whole-number quantity.`);
    }

    const acquisitionDate = purchase.purchaseDate || new Date();
    const nextAuditDueAt = new Date(
      new Date(acquisitionDate).getTime() + Number(category.auditFrequencyDays || 90) * 86400000,
    );
    const totalResidual = line.assetResidualValue !== null
      && line.assetResidualValue !== undefined
      ? Math.min(amount, Math.max(0, Number(line.assetResidualValue) || 0))
      : Number((amount * (Number(category.defaultResidualValuePercent || 0) / 100)).toFixed(2));
    const usefulLifeMonths = Math.max(
      1,
      Number(line.assetUsefulLifeMonths) || Number(category.defaultUsefulLifeMonths) || 60,
    );
    const common = {
      name: String(line.description || line.productName || category.name).trim(),
      category: category._id,
      trackingMode: category.trackingMode,
      outlet: purchase.outlet,
      location: line.assetLocation || '',
      unit: category.defaultUnit || line.unit || 'unit',
      acquisitionDate,
      depreciationStartDate: acquisitionDate,
      usefulLifeMonths,
      depreciationMethod: category.depreciationMethod || 'straightLine',
      condition: 'good',
      status: 'active',
      accounts: category.accounts,
      purchase: purchase._id,
      purchaseLineId: line._id,
      vendor: purchase.vendor || null,
      acquisitionJournalEntry: journalEntry._id,
      accountingLinked: true,
      source: 'purchase',
      notes: `Created from ${purchase.purchaseNumber}`,
      nextAuditDueAt,
      createdBy: userId,
      updatedBy: userId,
    };

    const values = [];
    if (category.trackingMode === 'serialized') {
      const totalCents = Math.round(amount * 100);
      const baseCents = Math.floor(totalCents / quantity);
      const remainingCents = totalCents - (baseCents * quantity);
      const residualCents = Math.round(totalResidual * 100);
      const residualBase = Math.floor(residualCents / quantity);
      const residualRemaining = residualCents - (residualBase * quantity);
      for (let index = 0; index < quantity; index += 1) {
        const cost = (baseCents + (index < remainingCents ? 1 : 0)) / 100;
        const residual = (residualBase + (index < residualRemaining ? 1 : 0)) / 100;
        values.push({
          quantity: 1,
          originalQuantity: 1,
          originalUnitCost: cost,
          originalCost: cost,
          grossCarryingAmount: cost,
          residualValue: Math.min(cost, residual),
        });
      }
    } else {
      values.push({
        quantity,
        originalQuantity: quantity,
        originalUnitCost: quantity ? amount / quantity : 0,
        originalCost: amount,
        grossCarryingAmount: amount,
        residualValue: totalResidual,
      });
    }

    for (const valuesForAsset of values) {
      const asset = await Asset.create({ ...common, ...valuesForAsset });
      assets.push(asset);
      undo.push(async () => Asset.deleteOne({ _id: asset._id }));
      const movement = await AssetMovement.create({
        asset: asset._id,
        outlet: asset.outlet,
        type: 'acquisition',
        quantityBefore: 0,
        quantityChange: asset.quantity,
        quantityAfter: asset.quantity,
        conditionAfter: asset.condition,
        locationAfter: asset.location,
        journalEntry: journalEntry._id,
        amount: asset.originalCost,
        reason: `Purchased on ${purchase.purchaseNumber}`,
        user: userId,
        at: purchase.purchaseDate || new Date(),
      });
      undo.push(async () => AssetMovement.deleteOne({ _id: movement._id }));
    }
  }
  return assets;
};

export const postPurchaseDocument = async (purchase, userId, { tenant } = {}) => {
  if (!['draft', 'pendingApproval'].includes(purchase.status)) {
    throw new Error(`Purchase ${purchase.purchaseNumber} is already posted.`);
  }
  validatePurchaseLineInputs(purchase.lines, purchase.type);

  const area = purchase.destination === 'kitchen' ? 'kitchen' : 'store';
  const byProduct = aggregatePurchaseLines(purchase.lines);
  const hasAssetLines = purchase.lines.some((line) => line.accountingTreatment === 'asset');
  if ((byProduct.size || hasAssetLines) && !purchase.outlet) {
    throw new Error('An outlet is required for inventory and asset purchase lines.');
  }
  if (hasAssetLines && !isAssetAuditEnabledForOutlet(tenant, purchase.outlet)) {
    throw new Error('Asset Register & Audit is not enabled for the selected outlet.');
  }

  if (hasAssetLines) {
    const categoryIds = purchase.lines
      .filter((line) => line.accountingTreatment === 'asset')
      .map((line) => line.assetCategory?._id || line.assetCategory)
      .filter(Boolean);
    const categories = await AssetCategory.find({
      _id: { $in: categoryIds },
      isActive: true,
    }).lean();
    const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
    for (const line of purchase.lines.filter((row) => row.accountingTreatment === 'asset')) {
      const category = categoryMap.get(String(line.assetCategory?._id || line.assetCategory || ''));
      if (!category?.accounts?.asset) {
        throw new Error('An asset category is invalid, inactive, or missing its fixed-asset COA head.');
      }
      line.assetAccount = category.accounts.asset;
    }
  }
  const productIds = [...byProduct.values()].map((row) => row.product);
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }) : [];
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));
  const onHandRows = productIds.length ? await StockItem.aggregate([
    { $match: { product: { $in: productIds } } },
    { $group: { _id: '$product', qty: { $sum: '$qtyOnHand' } } },
  ]) : [];
  const onHand = new Map(onHandRows.map((row) => [row._id.toString(), row.qty]));
  const inventoryCostChanges = new Map();

  const undo = [];
  let journalEntry;
  try {
    for (const [productId, row] of byProduct) {
      const product = productMap.get(productId);
      if (!product) throw new Error(`Product ${productId} no longer exists.`);
      const filter = { product: row.product, outlet: purchase.outlet, area };
      const update = {
        $inc: { qtyOnHand: row.units },
        $set: { updatedAt: new Date() },
        $setOnInsert: { product: row.product, outlet: purchase.outlet, area, unit: product.unit || '' },
      };
      try {
        await StockItem.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
      } catch (err) {
        if (err?.code !== 11000 || !(await dropLegacyStockIndexIfPresent())) throw err;
        await StockItem.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
      }
      undo.push(async () => StockItem.updateOne(filter, { $inc: { qtyOnHand: -row.units } }));

      normalizeLegacyProductPriceHistory(product);
      const snapshot = product.toObject();
      const oldQty = Math.max(0, Number(onHand.get(productId)) || 0);
      const oldCost = Number(product.currentPrice) || 0;
      const newCost = oldQty + row.units > 0
        ? round4(((oldQty * oldCost) + row.spend) / (oldQty + row.units))
        : 0;
      const receivedUnitCost = row.units > 0 ? round4(row.spend / row.units) : 0;
      inventoryCostChanges.set(productId, { before: oldCost, after: newCost });
      product.lastPrice = receivedUnitCost || product.lastPrice;
      product.currentPrice = newCost;
      if (row.entryMode === 'pack' && row.packSize > 1) {
        product.packSize = `${row.packSize} ${product.unit || 'units'}/pack`;
        const vendor = product.vendors?.find((entry) => entry.vendorId?.toString() === purchase.vendor?.toString());
        if (vendor) vendor.packSize = product.packSize;
      }
      if (receivedUnitCost > 0) {
        product.priceHistory.push({
          price: receivedUnitCost,
          date: purchase.purchaseDate || new Date(),
          changedBy: userId,
          source: 'purchase',
          purchase: purchase._id,
          vendorId: purchase.vendor || undefined,
        });
      }
      await product.save();
      undo.push(async () => Product.updateOne({ _id: product._id }, {
        $set: {
          currentPrice: snapshot.currentPrice,
          lastPrice: snapshot.lastPrice,
          priceHistory: snapshot.priceHistory,
          vendors: snapshot.vendors,
          packSize: snapshot.packSize,
        },
      }));
    }

    if (byProduct.size) {
      const movements = await StockMovement.insertMany([...byProduct].map(([productId, row]) => ({
        product: row.product,
        outlet: purchase.outlet,
        area,
        qty: row.units,
        unit: productMap.get(productId)?.unit || '',
        type: 'receipt',
        unitCost: row.units ? row.spend / row.units : 0,
        value: round4(row.spend),
        inventoryUnitCostBefore: inventoryCostChanges.get(productId)?.before,
        inventoryUnitCostAfter: inventoryCostChanges.get(productId)?.after,
        ref: { kind: 'purchase', id: purchase._id },
        note: purchase.itemSummary,
        user: userId,
        at: purchase.purchaseDate || new Date(),
      })));
      const movementIds = movements.map((movement) => movement._id);
      undo.push(async () => StockMovement.deleteMany({ _id: { $in: movementIds } }));
    }

    journalEntry = await postPurchase(purchase, userId);
    undo.push(async () => JournalEntry.deleteOne({ _id: journalEntry._id }));
    const createdAssets = await createPurchaseAssets(
      purchase,
      journalEntry,
      userId,
      undo,
    );
    purchase.status = purchase.amountPaid >= purchase.totalAmount && purchase.totalAmount > 0 ? 'paid' : 'open';
    purchase.postedAt = new Date();
    purchase.stockPostedAt = byProduct.size ? new Date() : null;
    purchase.assetPostedAt = createdAssets.length ? new Date() : null;
    purchase.postedBy = userId;
    purchase.journalEntryId = journalEntry._id;
    await purchase.save();
  } catch (err) {
    for (const fn of undo.reverse()) {
      try { await fn(); } catch (rollbackErr) {
        logger.error(`[purchase posting] rollback failed: ${rollbackErr.message}`);
      }
    }
    throw err;
  }

  if (byProduct.size) {
    try { await recomputeAllPrepCosts(); } catch (err) {
      logger.error(`Prep-cost refresh after ${purchase.purchaseNumber} failed: ${err.message}`);
    }
  }
  return journalEntry;
};
