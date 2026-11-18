import mongoose from 'mongoose';
import IngredientUsageLog from '../models/IngredientUsageLog.js';
import MenuItem from '../models/MenuItem.js';
import Product from '../models/Product.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { hasValidUnlock, isRecipeLockEnabled } from '../utils/recipeLock.js';

// ─── Adaptive Variance Helpers ─────────────────────────────────────────────────

const WINDOW_SIZE = 30;

function stats(values) {
    if (!values || values.length === 0) return { mean: 0, stdDev: 0 };
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Push a new actualUsage observation into the ingredient subdoc's rolling
 * window and recompute adaptiveVariance. Uses positional $ update so only
 * the matching subdocument is touched.
 */
export async function updateAdaptiveVariance(menuItemId, ingredientId, actualUsageObs) {
    const menuItem = await MenuItem.findOne(
        { _id: menuItemId, 'ingredients._id': ingredientId },
        { 'ingredients.$': 1 }
    ).lean();

    const ing = menuItem?.ingredients?.[0];
    if (!ing) return null;

    const win = [...(ing.usageWindow || []), actualUsageObs].slice(-WINDOW_SIZE);
    const { mean, stdDev } = stats(win);
    const computed = mean > 0 ? (stdDev / mean) * 100 : ing.varianceBaseline;
    const clamped = Math.min(50, Math.max(ing.varianceBaseline, Number(computed.toFixed(2))));

    await MenuItem.findOneAndUpdate(
        { _id: menuItemId, 'ingredients._id': ingredientId },
        { $set: { 'ingredients.$.usageWindow': win, 'ingredients.$.adaptiveVariance': clamped } }
    );

    return clamped;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECIPE CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// ── getRecipe ──────────────────────────────────────────────────────────────────
// GET /api/menu/items/:itemId/recipe?variationId=<id>
// Returns the variation's recipe when variationId is given, else the item recipe.
export const getRecipe = async (req, res) => {
    const { itemId } = req.params;
    const { variationId } = req.query;

    const menuItem = await MenuItem.findById(itemId)
        .populate('ingredients.product', 'name sku unit category')
        .populate('variations.ingredients.product', 'name sku unit category')
        .lean();

    if (!menuItem) return res.status(404).json({ success: false, message: 'Menu item not found.' });

    // A locked recipe never returns its ingredients without a valid unlock token.
    // We short-circuit BEFORE selecting any ingredient data into the response.
    if (menuItem.recipeLocked && !hasValidUnlock(req)) {
        return res.json({
            success: true,
            locked: true,
            data: [],
            trackInventory: !!menuItem.trackInventory,
        });
    }

    let ingredients = menuItem.ingredients ?? [];
    if (variationId) {
        const variation = (menuItem.variations || []).find((v) => v._id?.toString() === variationId);
        if (!variation) return res.status(404).json({ success: false, message: 'Variation not found.' });
        ingredients = variation.ingredients ?? [];
    }

    return res.json({
        success: true,
        locked: !!menuItem.recipeLocked,
        data: ingredients,
        trackInventory: !!menuItem.trackInventory,
    });
};

// ── setMenuRecipeLock ─────────────────────────────────────────────────────────
// PUT /api/menu/items/:itemId/recipe/lock   { locked }
// Locking (ON) needs only menu.manage. Unlocking (OFF) reveals the recipe, so it
// requires a valid unlock token (proof the caller knows the recipe password).
export const setMenuRecipeLock = async (req, res) => {
    const { itemId } = req.params;
    const locked = !!req.body.locked;

    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) return res.status(404).json({ success: false, message: 'Menu item not found.' });
    if (menuItem.itemType === 'deal') {
        return res.status(422).json({
            success: false,
            message: 'Deals use the recipes of their component items. Edit those regular menu items instead.',
        });
    }

    if (locked && !(await isRecipeLockEnabled())) {
        return res.status(400).json({ success: false, message: 'Set a recipe password in Settings before locking recipes.' });
    }
    if (!locked && menuItem.recipeLocked && !hasValidUnlock(req)) {
        return res.status(403).json({ success: false, message: 'Enter the recipe password to unlock this recipe.' });
    }

    menuItem.recipeLocked = locked;
    await menuItem.save();

    await AuditLog.create({
        user: req.user.id,
        action: locked ? 'menu_recipe_locked' : 'menu_recipe_unlocked',
        module: 'menu',
        recordId: menuItem._id,
        after: { name: menuItem.name, locked },
        ip: req.ip,
    }).catch(() => {});

    logger.info(`Menu recipe ${locked ? 'locked' : 'unlocked'}: "${menuItem.name}" by ${req.user.email}`);
    return res.json({ success: true, data: { id: menuItem._id, recipeLocked: locked } });
};

// ── saveRecipe ─────────────────────────────────────────────────────────────────
// PUT /api/menu/items/:itemId/recipe
// Body: { ingredients: [{ product, qty, unit, parLevel, varianceBaseline, notes }],
//         trackInventory?, variationId? }
// When variationId is present the recipe is written onto that variation; otherwise
// onto the item-level recipe.
export const saveRecipe = async (req, res) => {
    const { itemId } = req.params;
    const { ingredients = [], trackInventory, variationId } = req.body;

    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) return res.status(404).json({ success: false, message: 'Menu item not found.' });

    // Overwriting a locked recipe requires a valid unlock token.
    if (menuItem.recipeLocked && !hasValidUnlock(req)) {
        return res.status(403).json({ success: false, message: 'Enter the recipe password to edit this locked recipe.' });
    }

    // Resolve the target recipe array — a variation's, or the item's.
    let targetVariation = null;
    if (variationId) {
        targetVariation = menuItem.variations.id(variationId);
        if (!targetVariation) return res.status(404).json({ success: false, message: 'Variation not found.' });
    }
    const existingList = targetVariation ? (targetVariation.ingredients || []) : (menuItem.ingredients || []);

    // Validate all product IDs exist
    if (ingredients.length > 0) {
        const productIds = ingredients.map((i) => i.product);
        const found = await Product.countDocuments({ _id: { $in: productIds } });
        if (found !== productIds.length) {
            return res.status(422).json({ success: false, message: 'One or more products not found.' });
        }
    }

    // Build a map of existing adaptive data keyed by product ID string so we
    // can preserve rolling-window state when a product stays in the recipe.
    const existingMap = {};
    existingList.forEach((ing) => {
        existingMap[ing.product.toString()] = {
            _id: ing._id,
            usageWindow: ing.usageWindow ?? [],
            adaptiveVariance: ing.adaptiveVariance ?? 5,
        };
    });

    const newIngredients = ingredients.map((ing) => {
        const pid = (ing.product?._id ?? ing.product)?.toString?.() ?? '';
        const existing = existingMap[pid] ?? {};
        const entry = {
            product: ing.product,
            qty: ing.qty,
            unit: ing.unit,
            parLevel: ing.parLevel ?? 0,
            varianceBaseline: ing.varianceBaseline ?? 5,
            adaptiveVariance: existing.adaptiveVariance ?? ing.varianceBaseline ?? 5,
            usageWindow: existing.usageWindow ?? [],
            notes: ing.notes ?? '',
            createdBy: req.user.id,
        };
        // Preserve the existing subdocument _id so downstream references remain valid.
        if (existing._id) entry._id = existing._id;
        return entry;
    });

    if (targetVariation) {
        targetVariation.ingredients = newIngredients;
    } else {
        menuItem.ingredients = newIngredients;
    }

    // Inventory tracking is item-wide and manually controllable: track when ANY
    // recipe (item-level or any variation) has ingredients; honour an explicit
    // toggle in that case, else there is nothing to track.
    const anyIngredients = (menuItem.ingredients?.length ?? 0) > 0
        || (menuItem.variations || []).some((v) => (v.ingredients?.length ?? 0) > 0);
    menuItem.trackInventory = anyIngredients
        ? (typeof trackInventory === 'boolean' ? trackInventory : true)
        : false;
    await menuItem.save();

    // Reload with populated product to return the same shape as before.
    const updated = await MenuItem.findById(itemId)
        .populate('ingredients.product', 'name sku unit category')
        .populate('variations.ingredients.product', 'name sku unit category')
        .lean();

    let updatedIngredients = updated.ingredients ?? [];
    if (variationId) {
        const v = (updated.variations || []).find((x) => x._id?.toString() === variationId);
        updatedIngredients = v?.ingredients ?? [];
    }

    await AuditLog.create({
        user: req.user.id,
        action: 'recipe_saved',
        module: 'menu',
        recordId: itemId,
        after: { variationId: variationId ?? null, ingredientCount: newIngredients.length, trackInventory: menuItem.trackInventory },
        ip: req.ip,
    });

    logger.info(`Recipe saved for menu item ${itemId}${variationId ? ` variation ${variationId}` : ''} (${newIngredients.length} ingredients, trackInventory=${menuItem.trackInventory}) by ${req.user.email}`);

    return res.json({ success: true, data: updatedIngredients });
};

// ── deleteRecipeIngredient ─────────────────────────────────────────────────────
// DELETE /api/menu/items/:itemId/recipe/:ingredientId?variationId=<id>
export const deleteRecipeIngredient = async (req, res) => {
    const { itemId, ingredientId } = req.params;
    const { variationId } = req.query;

    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) return res.status(404).json({ success: false, message: 'Menu item not found.' });

    // Modifying a locked recipe requires a valid unlock token.
    if (menuItem.recipeLocked && !hasValidUnlock(req)) {
        return res.status(403).json({ success: false, message: 'Enter the recipe password to edit this locked recipe.' });
    }

    if (variationId) {
        const variation = menuItem.variations.id(variationId);
        if (!variation) return res.status(404).json({ success: false, message: 'Variation not found.' });
        variation.ingredients = (variation.ingredients || []).filter((ing) => ing._id?.toString() !== ingredientId);
    } else {
        menuItem.ingredients = (menuItem.ingredients || []).filter((ing) => ing._id?.toString() !== ingredientId);
    }

    // Auto-manage trackInventory: track while ANY recipe still has ingredients.
    menuItem.trackInventory = (menuItem.ingredients?.length ?? 0) > 0
        || (menuItem.variations || []).some((v) => (v.ingredients?.length ?? 0) > 0);
    await menuItem.save();

    logger.info(`Recipe ingredient ${ingredientId} removed from item ${itemId}${variationId ? ` variation ${variationId}` : ''} by ${req.user.email}`);

    return res.json({ success: true, message: 'Ingredient removed from recipe.' });
};

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE LOG & VARIANCE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// ── recordUsage ───────────────────────────────────────────────────────────────
// POST /api/menu/items/:itemId/recipe/usage
// Body: { date, actualUsage, outlet }
export const recordUsage = async (req, res) => {
    const { itemId } = req.params;
    const { date, actualUsages = [], outlet: rawOutlet } = req.body;

    const day = date ? new Date(date) : new Date();
    day.setUTCHours(0, 0, 0, 0);

    let outletId = null;
    if (rawOutlet && mongoose.isValidObjectId(rawOutlet)) {
        outletId = new mongoose.Types.ObjectId(rawOutlet);
    } else if (req.user?.outletRef && mongoose.isValidObjectId(req.user.outletRef)) {
        outletId = new mongoose.Types.ObjectId(req.user.outletRef);
    }

    const menuItemDoc = await MenuItem.findById(itemId).select('ingredients').lean();
    const ingList = menuItemDoc?.ingredients ?? [];

    const updated = [];
    for (const usage of actualUsages) {
        const ing = ingList.find((r) => r.product?.toString() === usage.product?.toString?.());
        if (!ing) continue;

        const newVariance = await updateAdaptiveVariance(itemId, ing._id, usage.actualUsage);

        const variance = usage.actualUsage - (usage.expectedUsage ?? 0);
        const variancePct = (usage.expectedUsage ?? 0) > 0
            ? (variance / usage.expectedUsage) * 100
            : 0;

        const logEntry = await IngredientUsageLog.findOneAndUpdate(
            { product: usage.product, outlet: outletId, date: day },
            {
                $set: {
                    expectedUsage: usage.expectedUsage ?? 0,
                    actualUsage: usage.actualUsage,
                    variance,
                    variancePct: Number(variancePct.toFixed(2)),
                    movingAvgVariance: newVariance,
                    unit: ing.unit,
                },
            },
            { upsert: true, returnDocument: 'after' }
        );

        updated.push({ product: usage.product, adaptiveVariance: newVariance, log: logEntry });
    }

    return res.json({ success: true, data: updated });
};

// ── getUsageHistory ───────────────────────────────────────────────────────────
// GET /api/inventory/usage-history/:productId?outlet=&days=30
export const getUsageHistory = async (req, res) => {
    const { productId } = req.params;
    const { outlet, days = 30 } = req.query;

    const since = new Date();
    since.setDate(since.getDate() - parseInt(days, 10));
    since.setUTCHours(0, 0, 0, 0);

    const match = { product: new mongoose.Types.ObjectId(productId), date: { $gte: since } };
    if (outlet && mongoose.isValidObjectId(outlet)) match.outlet = new mongoose.Types.ObjectId(outlet);

    const logs = await IngredientUsageLog.find(match).sort({ date: 1 }).lean();

    // Find all menu items that use this product and expose the ingredient config
    // (adaptiveVariance, parLevel, varianceBaseline) for each.
    const pid = new mongoose.Types.ObjectId(productId);
    const menuItemsAll = await MenuItem.find({
        $or: [{ 'ingredients.product': pid }, { 'variations.ingredients.product': pid }],
    })
        .select('name ingredients variations recipeLocked')
        .lean();

    // A locked recipe must not reveal, per menu item, WHICH product it uses or in
    // what quantity — that composition is the recipe secret. Drop locked items
    // from the per-item breakdown unless the caller holds a valid unlock token.
    // (The product-level usage `logs` are aggregate and stay.)
    const unlocked = hasValidUnlock(req);
    const menuItems = unlocked ? menuItemsAll : menuItemsAll.filter((mi) => !mi.recipeLocked);

    // Include the item recipe AND each size's recipe — a product may live only in
    // a variation's recipe.
    const recipes = menuItems.flatMap((mi) => {
        const fromItem = (mi.ingredients || [])
            .filter((ing) => ing.product?.toString() === productId)
            .map((ing) => ({ ...ing, menuItem: { _id: mi._id, name: mi.name } }));
        const fromVariations = (mi.variations || []).flatMap((v) =>
            (v.ingredients || [])
                .filter((ing) => ing.product?.toString() === productId)
                .map((ing) => ({ ...ing, menuItem: { _id: mi._id, name: `${mi.name} (${v.name})` } }))
        );
        return [...fromItem, ...fromVariations];
    });

    return res.json({ success: true, data: { logs, recipes } });
};

// ── getInventoryInsightsDashboard ─────────────────────────────────────────────
// GET /api/inventory/insights?outlet=&days=14
export const getInventoryInsightsDashboard = async (req, res) => {
    const { outlet, days = 14 } = req.query;

    const since = new Date();
    since.setDate(since.getDate() - parseInt(days, 10));
    since.setUTCHours(0, 0, 0, 0);

    const outletObjId = (outlet && mongoose.isValidObjectId(outlet))
        ? new mongoose.Types.ObjectId(outlet)
        : null;

    const stockMatchExpr = outletObjId
        ? { $and: [{ $eq: ['$product', '$$pid'] }, { $eq: ['$outlet', outletObjId] }] }
        : { $eq: ['$product', '$$pid'] };

    // This dashboard aggregates by PRODUCT (never per-dish), so it can't reveal a
    // locked recipe's composition (which dish uses what, or per-serving qty). Per
    // the recipe-lock decision "keep aggregate totals, hide composition", locked
    // recipes ARE included here — otherwise the tracked-ingredient count/variance
    // wrongly drops to 0 when the only recipes are locked. Per-dish drill-downs
    // (getRecipe, getUsageHistory) stay gated.
    const pipeline = [
        {
            $match: {
                $or: [
                    { 'ingredients.0': { $exists: true } },
                    { 'variations.ingredients.0': { $exists: true } },
                ],
            },
        },
        {
            $project: {
                ingredients: {
                    $concatArrays: [
                        { $ifNull: ['$ingredients', []] },
                        {
                            $reduce: {
                                input: { $ifNull: ['$variations', []] },
                                initialValue: [],
                                in: { $concatArrays: ['$$value', { $ifNull: ['$$this.ingredients', []] }] },
                            },
                        },
                    ],
                },
            },
        },
        { $unwind: '$ingredients' },
        {
            $group: {
                _id: '$ingredients.product',
                adaptiveVariance: { $max: '$ingredients.adaptiveVariance' },
                varianceBaseline: { $max: '$ingredients.varianceBaseline' },
                parLevel: { $max: '$ingredients.parLevel' },
                unit: { $first: '$ingredients.unit' },
            },
        },
        {
            $lookup: {
                from: 'products',
                localField: '_id',
                foreignField: '_id',
                as: 'productData',
            },
        },
        { $unwind: '$productData' },
        {
            $lookup: {
                from: 'stockitems',
                let: { pid: '$_id' },
                pipeline: [{ $match: { $expr: stockMatchExpr } }],
                as: 'stockData',
            },
        },
        {
            $addFields: {
                productName: '$productData.name',
                sku: '$productData.sku',
                category: '$productData.category',
                parLevel: {
                    $cond: [
                        { $gt: [{ $ifNull: ['$productData.parLevel', 0] }, 0] },
                        '$productData.parLevel',
                        { $ifNull: ['$parLevel', 0] },
                    ],
                },
                qtyOnHand: {
                    $reduce: {
                        input: '$stockData',
                        initialValue: 0,
                        in: { $add: ['$$value', { $ifNull: ['$$this.qtyOnHand', 0] }] },
                    },
                },
            },
        },
        {
            $addFields: {
                belowPar: {
                    $cond: [
                        { $gt: ['$parLevel', 0] },
                        { $lt: ['$qtyOnHand', '$parLevel'] },
                        false,
                    ],
                },
                parLevelBreach: { $lte: ['$qtyOnHand', 0] },
            },
        },
        {
            $project: {
                productName: 1,
                sku: 1,
                category: 1,
                unit: 1,
                qtyOnHand: 1,
                parLevel: 1,
                adaptiveVariance: 1,
                varianceBaseline: 1,
                belowPar: 1,
                parLevelBreach: 1,
            },
        },
        { $sort: { parLevelBreach: -1, belowPar: -1, productName: 1 } },
    ];

    const stockWithRecipe = await MenuItem.aggregate(pipeline);

    // ── Usage log aggregates for the window ─────────────────────────────────────
    const matchLogs = { date: { $gte: since } };
    if (outletObjId) matchLogs.outlet = outletObjId;

    const usageSummary = await IngredientUsageLog.aggregate([
        { $match: matchLogs },
        {
            $group: {
                _id: '$product',
                totalExpected: { $sum: '$expectedUsage' },
                totalActual: { $sum: '$actualUsage' },
                avgVariancePct: { $avg: '$variancePct' },
                lastDate: { $max: '$date' },
                daysWithActuals: {
                    $sum: { $cond: [{ $gt: ['$actualUsage', 0] }, 1, 0] },
                },
            },
        },
    ]);

    const usageMap = {};
    usageSummary.forEach((u) => { usageMap[u._id.toString()] = u; });

    const enriched = stockWithRecipe.map((item) => ({
        ...item,
        usage: usageMap[item._id?.toString()] ?? null,
    }));

    // ── KPIs ────────────────────────────────────────────────────────────────────
    const totalTracked = enriched.length;
    const belowParCount = enriched.filter((i) => i.belowPar && !i.parLevelBreach).length;
    const parLevelBreaches = enriched.filter((i) => i.parLevelBreach).length;
    const highVarianceCount = enriched.filter(
        (i) => i.usage && i.usage.daysWithActuals > 0 && Math.abs(i.usage.avgVariancePct ?? 0) > (i.adaptiveVariance ?? 0)
    ).length;

    // ── 14-day trend (daily) ────────────────────────────────────────────────────
    const dailyTrend = await IngredientUsageLog.aggregate([
        { $match: matchLogs },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
                totalExpected: { $sum: '$expectedUsage' },
                totalActual: { $sum: '$actualUsage' },
                avgVariancePct: { $avg: '$variancePct' },
            },
        },
        { $sort: { _id: 1 } },
        {
            $project: {
                date: '$_id',
                totalExpected: 1,
                totalActual: 1,
                avgVariancePct: { $round: ['$avgVariancePct', 2] },
                _id: 0,
            },
        },
    ]);

    return res.json({
        success: true,
        data: {
            kpis: { totalTracked, belowParCount, parLevelBreaches, highVarianceCount },
            ingredients: enriched,
            dailyTrend,
        },
    });
};

// ── getDetailedIngredients ─────────────────────────────────────────────────────
// GET /api/inventory/insights/detailed
export const getDetailedIngredients = async (req, res) => {
    const { ingredient, outlet, dateFrom, dateTo, pattern, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));

    const logMatch = {};
    if (ingredient) logMatch.product = new mongoose.Types.ObjectId(ingredient);
    if (outlet && mongoose.isValidObjectId(outlet)) logMatch.outlet = new mongoose.Types.ObjectId(outlet);
    if (dateFrom || dateTo) {
        logMatch.date = {};
        if (dateFrom) logMatch.date.$gte = new Date(dateFrom);
        if (dateTo) { const end = new Date(dateTo); end.setUTCHours(23, 59, 59, 999); logMatch.date.$lte = end; }
    }
    if (pattern === 'highVariance') logMatch.$expr = { $gt: [{ $abs: '$variancePct' }, 10] };
    if (pattern === 'overConsumption') logMatch.variance = { $gt: 0 };
    if (pattern === 'underConsumption') logMatch.variance = { $lt: 0 };

    const [logs, total] = await Promise.all([
        IngredientUsageLog.find(logMatch)
            .sort({ date: -1 })
            .skip((pageNum - 1) * pageSize)
            .limit(pageSize)
            .populate('product', 'name sku unit category')
            .lean(),
        IngredientUsageLog.countDocuments(logMatch),
    ]);

    // Attach recipe config (adaptiveVariance, parLevel) from embedded ingredients.
    const productIds = [...new Set(logs.map((l) => l.product?._id?.toString()))].filter(Boolean);
    const objIds = productIds.map((id) => new mongoose.Types.ObjectId(id));
    // Product-level config envelope (max par/variance across recipes) — never
    // names a dish or a per-serving qty, so it isn't recipe composition. Include
    // locked recipes so this drill-down reconciles with the aggregate dashboard.
    const menuItems = await MenuItem.find({
        $or: [{ 'ingredients.product': { $in: objIds } }, { 'variations.ingredients.product': { $in: objIds } }],
    })
        .select('ingredients variations')
        .lean();

    // A product can appear in many recipes (items + sizes), each with its own
    // par/variance config. The usage log is a product-level daily aggregate, so
    // there is no single "right" recipe — show a deterministic conservative
    // envelope (max par/variance) instead of whichever doc happened to load first.
    const recipeMap = {};
    const absorb = (ings) => (ings || []).forEach((ing) => {
        const pid = ing.product?.toString();
        if (!pid) return;
        const cur = recipeMap[pid];
        recipeMap[pid] = cur
            ? {
                ...cur,
                parLevel: Math.max(cur.parLevel || 0, ing.parLevel || 0),
                varianceBaseline: Math.max(cur.varianceBaseline || 0, ing.varianceBaseline || 0),
                adaptiveVariance: Math.max(cur.adaptiveVariance || 0, ing.adaptiveVariance || 0),
            }
            : ing;
    });
    menuItems.forEach((mi) => {
        absorb(mi.ingredients);
        (mi.variations || []).forEach((v) => absorb(v.ingredients));
    });

    const enrichedLogs = logs.map((log) => ({
        ...log,
        recipe: recipeMap[log.product?._id?.toString()] ?? null,
    }));

    return res.json({
        success: true,
        data: {
            logs: enrichedLogs,
            pagination: { total, page: pageNum, pages: Math.ceil(total / pageSize), limit: pageSize },
        },
    });
};
