import Outlet from '../models/Outlet.js';
import MenuCategory from '../models/MenuCategory.js';
import MenuItem from '../models/MenuItem.js';
import mongoose from 'mongoose';
import StockItem from '../models/StockItem.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { convertQty } from '../utils/unitConversion.js';
import { hasValidUnlock } from '../utils/recipeLock.js';
import { isDealCurrentlyAvailable } from '../services/deal.service.js';

// ── getPOSMenu ─────────────────────────────────────────────────────────────────
// GET /api/pos/menu/:outletId
//
// Returns all active categories with their active items for the POS screen.
// Response shape:
//   {
//     outlet: { _id, name, code, timezone },
//     categories: [
//       { _id, name, color, sortOrder, items: [{ _id, name, price, taxRate, isAvailable, sortOrder, sku, trackInventory }] }
//     ]
//   }
//
// Categories sorted by sortOrder asc; items sorted by sortOrder asc within each category.

export const getPOSMenu = async (req, res) => {
  const { outletId } = req.params;

  // Accept either ObjectId or outlet code (e.g. REST-001)
  let outlet;
  const looksLikeId = typeof outletId === 'string' && /^[0-9a-fA-F]{24}$/.test(outletId);
  if (looksLikeId) {
    outlet = await Outlet.findById(outletId).select('name code timezone isActive').lean();
  } else {
    outlet = await Outlet.findOne({ code: outletId.toUpperCase() }).select('name code timezone isActive').lean();
  }

  if (!outlet) {
    return res.status(404).json({ success: false, message: 'Outlet not found.' });
  }

  if (!outlet.isActive) {
    return res.status(403).json({ success: false, message: 'Outlet is inactive.' });
  }

  // Fetch all active categories for this outlet
  const outletMatchValue = outlet._id ? outlet._id : outlet.code;
  const categories = await MenuCategory.find({ outlet: outletMatchValue, isActive: true })
    .select('name color sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  if (categories.length === 0) {
    return res.json({ success: true, outlet, categories: [] });
  }

  const categoryIds = categories.map((c) => c._id);

  // Fetch all available items belonging to those categories in one query
  const items = await MenuItem.find({
    outlet: outletMatchValue,
    category: { $in: categoryIds },
    isAvailable: true,
  })
    .populate('dealConfig.fixedItems.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
    .populate('dealConfig.choiceGroups.options.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
    .select('name itemType dealConfig price foodPandaPrice priceMode taxRate serviceCharge isAvailable sortOrder sku trackInventory category imageUrl variations')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  // Group items by category id for O(n) assembly
  const itemsByCategory = {};
  for (const item of items) {
    if (!isDealCurrentlyAvailable(item)) continue;
    const catId = item.category.toString();
    if (!itemsByCategory[catId]) itemsByCategory[catId] = [];
    itemsByCategory[catId].push({
      _id: item._id,
      name: item.name,
      price: item.price,
      foodPandaPrice: item.foodPandaPrice,
      priceMode: item.priceMode || 'exclusive',
      taxRate: item.taxRate,
      serviceCharge: item.serviceCharge,
      isAvailable: item.isAvailable,
      sortOrder: item.sortOrder,
      sku: item.sku,
      trackInventory: item.trackInventory,
      imageUrl: item.imageUrl,
      itemType: item.itemType || 'regular',
      dealConfig: item.itemType === 'deal' ? item.dealConfig : undefined,
      // Sizes (name + price only) so the POS can show a size picker. Recipes are
      // intentionally omitted from the menu payload to keep it light.
      variations: (item.variations ?? [])
        .slice()
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((v) => ({
          _id: v._id,
          name: v.name,
          price: v.price,
          foodPandaPrice: v.foodPandaPrice,
          sortOrder: v.sortOrder ?? 0,
        })),
    });
  }

  const payload = categories.map((cat) => ({
    _id: cat._id,
    name: cat.name,
    color: cat.color,
    sortOrder: cat.sortOrder,
    items: itemsByCategory[cat._id.toString()] ?? [],
  }));

  return res.json({ success: true, outlet, categories: payload });
};

// ── getPOSMenuAvailability ────────────────────────────────────────────────────
// GET /api/pos/menu/:outletId/availability
//
// Returns, for each *available* menu item, how many units the cashier can
// realistically punch given current stock + recipe requirements.
//
// Response:
//   {
//     success: true,
//     availability: {
//       <menuItemId>: {
//         available: number | null,   // null = unlimited (not tracked)
//         hasRecipe: boolean,         // true if at least one ingredient
//         missingRecipe: boolean,     // tracked but no ingredients defined
//         bottleneck?: string,        // ingredient that limits supply
//       }
//     }
//   }

export const getPOSMenuAvailability = async (req, res) => {
  const { outletId } = req.params;

  let outlet;
  const looksLikeId = typeof outletId === 'string' && /^[0-9a-fA-F]{24}$/.test(outletId);
  if (looksLikeId) {
    outlet = await Outlet.findById(outletId).select('_id code isActive').lean();
  } else {
    outlet = await Outlet.findOne({ code: outletId.toUpperCase() }).select('_id code isActive').lean();
  }
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  if (!outlet.isActive) return res.status(403).json({ success: false, message: 'Outlet is inactive.' });

  // Fetch all available menu items for this outlet with recipe ingredients.
  const items = await MenuItem.find({
    outlet: outlet._id,
    isAvailable: true,
  })
    .select('name itemType dealConfig trackInventory ingredients variations recipeLocked')
    .populate('ingredients.product', 'name unit')
    .populate('variations.ingredients.product', 'name unit')
    .lean();

  if (items.length === 0) {
    return res.json({ success: true, availability: {} });
  }

  // Collect every ingredient product id used across the menu — item-level recipes
  // AND every size's recipe — and look up current stock in one query (tolerant of
  // legacy outlet-as-code data).
  const productIds = new Set();
  const addIngredientProducts = (ings) => {
    for (const ing of ings || []) {
      if (ing.product?._id) productIds.add(ing.product._id.toString());
    }
  };
  for (const it of items) {
    addIngredientProducts(it.ingredients);
    for (const v of it.variations || []) addIngredientProducts(v.ingredients);
  }

  // Raw collection bypasses Mongoose's cast validation — required because
  // legacy StockItem documents may have `outlet` stored as a string code
  // even though the schema declares ObjectId. A regular find() throws
  // CastError on the string branch of `$or`.
  const stockItems = productIds.size
    ? await StockItem.collection
        .find({
          product: { $in: [...productIds].map((id) => new mongoose.Types.ObjectId(id)) },
          area: 'kitchen',
          $or: [{ outlet: outlet._id }, { outlet: outlet.code }],
        })
        .project({ product: 1, qtyOnHand: 1, unit: 1 })
        .toArray()
    : [];

  const stockByProduct = new Map(
    stockItems.map((s) => [s.product.toString(), { qtyOnHand: s.qtyOnHand, unit: s.unit }]),
  );

  // ── Reservations: held orders consume ingredients too ──────────────────────
  // The kitchen has already started preparing held orders, so their recipe
  // ingredients should be subtracted from on-hand stock when computing what
  // the cashier can still punch onto a fresh order.
  const heldOrders = await SaleTransaction.find({
    outlet: outlet._id,
    status: 'held',
  })
    .select('items')
    .lean();

  // productId → total qty (in stock unit) reserved by held orders
  const reservedByProduct = new Map();

  if (heldOrders.length > 0) {
    // We need each menu item's recipe to translate held items into ingredient
    // requirements. The MenuItem set we already fetched is filtered by
    // `isAvailable: true`, but a held order may reference an item that's
    // since been disabled — pull those by id as a fallback so we don't
    // under-reserve.
    const heldMenuItemIds = new Set();
    for (const ho of heldOrders) {
      for (const it of ho.items || []) {
        const mid = it.menuItem?.toString();
        if (mid) heldMenuItemIds.add(mid);
        for (const component of it.dealComponents || []) {
          const componentId = component.menuItem?.toString();
          if (componentId) heldMenuItemIds.add(componentId);
        }
      }
    }
    const knownById = new Map(items.map((m) => [m._id.toString(), m]));
    const missingIds = [...heldMenuItemIds].filter((id) => !knownById.has(id));
    let extraMenuItems = [];
    if (missingIds.length > 0) {
      extraMenuItems = await MenuItem.find({ _id: { $in: missingIds } })
        .select('trackInventory ingredients variations')
        .populate('ingredients.product', 'name unit')
        .populate('variations.ingredients.product', 'name unit')
        .lean();
      for (const m of extraMenuItems) knownById.set(m._id.toString(), m);
    }

    for (const ho of heldOrders) {
      for (const line of ho.items || []) {
        const recipeSources = line.dealComponents?.length
          ? line.dealComponents.map((component) => ({
              mi: knownById.get(component.menuItem?.toString()),
              variationId: component.variation?.id,
              qtySold: (Number(line.qty) || 0) * (Number(component.qtyPerDeal) || 1),
            }))
          : [{
              mi: knownById.get(line.menuItem?.toString()),
              variationId: line.variation?.id,
              qtySold: Number(line.qty) || 0,
            }];
        for (const source of recipeSources) {
          if (!source.mi?.trackInventory || source.qtySold <= 0) continue;
          let heldIngs = source.mi.ingredients || [];
          if (source.variationId) {
            const hv = (source.mi.variations || []).find((x) => x._id.toString() === source.variationId.toString());
            heldIngs = hv?.ingredients || [];
          }
          for (const ing of heldIngs) {
          if (!ing.product?._id) continue;
          const recipeQty = Number(ing.qty) || 0;
          if (recipeQty <= 0) continue;
          const stockUnit = ing.product.unit || ing.unit;
          const { qty: perUnit, converted } = convertQty(recipeQty, ing.unit, stockUnit);
          if (!converted) continue;
          const total = perUnit * source.qtySold;
          const pid = ing.product._id.toString();
          reservedByProduct.set(pid, (reservedByProduct.get(pid) || 0) + total);
          }
        }
      }
    }
  }

  const effectiveStock = (pid) => {
    const stock = stockByProduct.get(pid);
    const onHand = stock?.qtyOnHand ?? 0;
    const reserved = reservedByProduct.get(pid) || 0;
    return Math.max(0, onHand - reserved);
  };

  // Evaluate a recipe (ingredient list) against current stock. Returns the max
  // sellable `units` (Infinity for an empty recipe = unlimited; 0 when an
  // ingredient is depleted/unconvertible), the limiting `bottleneck`, and the
  // per-unit consumption `recipe` in STOCK units so the client can model the
  // shared pool as the cart grows.
  const evalRecipe = (ingredients) => {
    // Aggregate consumption PER PRODUCT first — a product can appear in more than
    // one ingredient line, and the sale-deduction path sums them, so availability
    // must too (else a duplicate-product recipe over-counts what's makeable).
    const byProduct = new Map();
    for (const ing of ingredients || []) {
      const product = ing.product;
      if (!product?._id) continue;
      const recipeQty = Number(ing.qty) || 0;
      if (recipeQty <= 0) continue;
      const pid = product._id.toString();
      const stockUnit = product.unit || ing.unit;
      const { qty: needPerUnit, converted } = convertQty(recipeQty, ing.unit, stockUnit);
      const entry = byProduct.get(pid) || { product: pid, name: product.name, qty: 0, unconvertible: false };
      if (!converted || needPerUnit <= 0) entry.unconvertible = true;
      else entry.qty += needPerUnit;
      byProduct.set(pid, entry);
    }

    const recipe = [...byProduct.values()];
    let minUnits = Infinity;
    let bottleneck = null;
    for (const r of recipe) {
      if (r.unconvertible || !(r.qty > 0)) {
        // Cannot evaluate — treat as a hard zero so the cashier sees the gap.
        return { units: 0, bottleneck: r.name || 'unconvertible ingredient', recipe };
      }
      const sellable = Math.floor(effectiveStock(r.product) / r.qty);
      if (sellable < minUnits) {
        minUnits = sellable;
        bottleneck = r.name;
      }
    }
    return { units: minUnits, bottleneck, recipe };
  };

  const availability = {};

  for (const item of items) {
    const id = item._id.toString();
    const hasVariations = (item.variations?.length || 0) > 0;

    // Items not flagged for tracking are effectively unlimited.
    if (!item.trackInventory) {
      const hasRecipe = (item.ingredients?.length || 0) > 0
        || (item.variations || []).some((v) => (v.ingredients?.length || 0) > 0);
      availability[id] = { available: null, hasRecipe, missingRecipe: false };
      continue;
    }

    // Shared stock pool for this item's ingredients — the client subtracts the
    // cart's consumption from this so every size's count updates live.
    const stock = {};
    const addStock = (recipe) => {
      for (const r of recipe) {
        if (stock[r.product]) continue;
        const s = stockByProduct.get(r.product);
        stock[r.product] = { available: effectiveStock(r.product), name: r.name, unit: s?.unit ?? null };
      }
    };

    if (hasVariations) {
      // Evaluate each size's own recipe. The item-level `available` is the BEST
      // case across sizes (the cashier can pick the most-available size), so the
      // tile only shows "Out" when EVERY size is depleted. A size with no recipe
      // is unlimited. Per-size detail (count + recipe) rides along in `variations`.
      const variations = {};
      let anyRecipe = false;
      let anyUnlimited = false;
      let bestFinite = -Infinity;
      let bestBottleneck = null;

      for (const v of item.variations) {
        const ings = v.ingredients || [];
        if (ings.length === 0) {
          variations[v._id.toString()] = { available: null, recipe: [] };
          anyUnlimited = true;
          continue;
        }
        anyRecipe = true;
        const { units, bottleneck, recipe } = evalRecipe(ings);
        addStock(recipe);
        const avail = Number.isFinite(units) ? Math.max(0, units) : null;
        variations[v._id.toString()] = {
          available: avail,
          recipe,
          ...(bottleneck && avail != null ? { bottleneck } : {}),
        };
        if (avail == null) anyUnlimited = true;
        else if (avail > bestFinite) { bestFinite = avail; bestBottleneck = bottleneck; }
      }

      const itemLevel = anyUnlimited ? null : (bestFinite === -Infinity ? null : bestFinite);
      availability[id] = {
        available: itemLevel,
        hasRecipe: anyRecipe,
        missingRecipe: !anyRecipe,
        ...(itemLevel != null && bestBottleneck ? { bottleneck: bestBottleneck } : {}),
        variations,
        stock,
      };
      continue;
    }

    // No variations — item-level recipe.
    const ingredients = item.ingredients || [];
    if (ingredients.length === 0) {
      availability[id] = { available: null, hasRecipe: false, missingRecipe: true };
      continue;
    }
    const { units, bottleneck, recipe } = evalRecipe(ingredients);
    addStock(recipe);
    const avail = Number.isFinite(units) ? Math.max(0, units) : null;
    availability[id] = {
      available: avail,
      hasRecipe: true,
      missingRecipe: false,
      ...(bottleneck && avail != null ? { bottleneck } : {}),
      recipe,
      stock,
    };
  }

  // A locked item's availability may only expose the COUNT — never the recipe
  // composition (recipe rows, per-product stock, or the bottleneck product name),
  // which would reveal the protected recipe. Strip those unless the caller holds
  // a valid unlock token. The cashier still sees the item's available count.
  if (!hasValidUnlock(req)) {
    for (const it of items) {
      if (!it.recipeLocked) continue;
      const a = availability[it._id.toString()];
      if (!a) continue;
      delete a.recipe;
      delete a.stock;
      delete a.bottleneck;
      if (a.variations) {
        for (const vid of Object.keys(a.variations)) {
          a.variations[vid] = { available: a.variations[vid].available };
        }
      }
    }
  }

  return res.json({ success: true, availability });
};

// ── getPOSCategories ───────────────────────────────────────────────────────────
// GET /api/pos/menu/categories/:outletId
//
// Categories only — lighter endpoint for quick tab refresh mid-service.

export const getPOSCategories = async (req, res) => {
  const { outletId } = req.params;

  // Accept either ObjectId or outlet code
  let outlet2;
  const looksLikeId2 = typeof outletId === 'string' && /^[0-9a-fA-F]{24}$/.test(outletId);
  if (looksLikeId2) {
    outlet2 = await Outlet.findById(outletId).select('isActive').lean();
  } else {
    outlet2 = await Outlet.findOne({ code: outletId.toUpperCase() }).select('isActive').lean();
  }

  if (!outlet2) {
    return res.status(404).json({ success: false, message: 'Outlet not found.' });
  }

  if (!outlet2.isActive) {
    return res.status(403).json({ success: false, message: 'Outlet is inactive.' });
  }

  const outletMatchValue2 = outlet2._id ? outlet2._id : outlet2.code;
  const categories = await MenuCategory.find({ outlet: outletMatchValue2, isActive: true })
    .select('name color sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  return res.json({ success: true, data: categories });
};
