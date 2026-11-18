import mongoose from 'mongoose';
import PrepRecipe from '../models/PrepRecipe.js';
import Product from '../models/Product.js';
import StockItem from '../models/StockItem.js';
import Outlet from '../models/Outlet.js';
import MenuItem from '../models/MenuItem.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { ingredientCostValue, convertQty } from '../services/saleWaste.service.js';
import { recordStockMovements } from '../services/stockLedger.js';
import { hasValidUnlock, isRecipeLockEnabled, stripPrepRecipe } from '../utils/recipeLock.js';

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

// ═══════════════════════════════════════════════════════════════════════════════
// COST ROLLUP (recursive, cycle-safe)
// ═══════════════════════════════════════════════════════════════════════════════

// Compute { batchCost, perUnit, ok } for one prep. A prep ingredient that is
// itself a prep contributes its OWN perUnit cost (recursion). `memo` caches
// results across the whole set; `stack` detects cycles within a single DFS.
const computePrepCost = (prep, prepByProductId, memo, stack) => {
  const id = prep._id.toString();
  if (memo.has(id)) return memo.get(id);
  if (stack.has(id)) return null; // cycle — caller treats as unresolved

  stack.add(id);
  let batchCost = 0;
  let ok = true;

  for (const ing of prep.ingredients || []) {
    const prod = ing.product;
    if (!prod) continue;
    const prodId = (prod._id ?? prod).toString();
    const sub = prepByProductId[prodId];
    let unitCost = 0;
    if (sub) {
      const subRes = computePrepCost(sub, prepByProductId, memo, stack);
      if (!subRes) ok = false; // cycle below us
      else unitCost = subRes.perUnit;
    } else {
      // currentPrice is the canonical weighted-average cost; vendor/default are fallbacks.
      unitCost = prod.currentPrice || prod.vendors?.[0]?.currentPrice || prod.defaultPrice || 0;
    }
    batchCost += ingredientCostValue(ing.qty, ing.unit, unitCost, prod.unit || ing.unit);
  }

  stack.delete(id);
  const res = {
    batchCost: round2(batchCost),
    perUnit: prep.yieldQty > 0 ? round2(batchCost / prep.yieldQty) : 0,
    ok,
  };
  memo.set(id, res);
  return res;
};

// Recompute costs for ALL preps and mirror each cost-per-unit onto its backing
// product (so menu-item recipe costing & sale deduction price the prep just
// like a raw ingredient). Cheap — prep counts are small — and keeps every prep
// fresh when a shared sub-prep or a raw price changes.
export const recomputeAllPrepCosts = async () => {
  const preps = await PrepRecipe.find({})
    .populate('ingredients.product', 'name unit vendors defaultPrice currentPrice kind')
    .lean();

  const prepByProductId = {};
  preps.forEach((p) => { if (p.product) prepByProductId[p.product.toString()] = p; });

  const memo = new Map();
  const prepOps = [];
  const prodOps = [];

  for (const p of preps) {
    const res = computePrepCost(p, prepByProductId, memo, new Set()) || { batchCost: 0, perUnit: 0 };
    prepOps.push({ updateOne: { filter: { _id: p._id }, update: { $set: { costPerBatch: res.batchCost, costPerUnit: res.perUnit } } } });
    if (p.product) {
      prodOps.push({ updateOne: { filter: { _id: p.product }, update: { $set: { currentPrice: res.perUnit, defaultPrice: res.perUnit } } } });
    }
  }

  if (prepOps.length) await PrepRecipe.bulkWrite(prepOps, { ordered: false });
  if (prodOps.length) await Product.bulkWrite(prodOps, { ordered: false });
};

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE GUARD
// ═══════════════════════════════════════════════════════════════════════════════

// Returns true if making `candidatePrepId` depend on `candidateProductIds`
// would create a circular reference among preps (A → B → A). For a brand-new
// prep pass candidatePrepId = null (keyed as 'NEW').
const wouldCreateCycle = async (candidatePrepId, candidateProductIds) => {
  const preps = await PrepRecipe.find({}, 'product ingredients').lean();

  const prepIdByProduct = {};
  preps.forEach((p) => { if (p.product) prepIdByProduct[p.product.toString()] = p._id.toString(); });

  // Adjacency: prepKey → [prepKeys it depends on].
  const deps = {};
  preps.forEach((p) => {
    const key = p._id.toString();
    deps[key] = (p.ingredients || [])
      .map((i) => prepIdByProduct[(i.product?._id ?? i.product).toString()])
      .filter(Boolean);
  });

  const startKey = candidatePrepId ? candidatePrepId.toString() : 'NEW';
  deps[startKey] = (candidateProductIds || [])
    .map((pid) => prepIdByProduct[pid.toString()])
    .filter(Boolean);

  // DFS from the candidate — if we can get back to it, there's a cycle.
  const seen = new Set();
  const stack = [...deps[startKey]];
  while (stack.length) {
    const k = stack.pop();
    if (k === startKey) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    (deps[k] || []).forEach((d) => stack.push(d));
  }
  return false;
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const resolveOutletId = (req) => {
  const raw = req.query.outlet || req.body.outlet;
  if (raw && mongoose.isValidObjectId(raw)) return new mongoose.Types.ObjectId(raw);
  if (req.user?.outletRef && mongoose.isValidObjectId(req.user.outletRef)) {
    return new mongoose.Types.ObjectId(req.user.outletRef);
  }
  return null;
};

const validateIngredientProducts = async (ingredients) => {
  const ids = (ingredients || []).map((i) => i.product?.toString()).filter(Boolean);
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return true;
  const found = await Product.countDocuments({ _id: { $in: uniq } });
  return found === uniq.length;
};

// Shape a prep for the client, attaching on-hand stock at the given outlet.
const shapePrep = async (prepId, outletId) => {
  const prep = await PrepRecipe.findById(prepId)
    .populate('ingredients.product', 'name sku unit kind')
    .populate('product', 'name sku unit kind currentPrice')
    .lean();
  if (!prep) return null;
  let qtyOnHand = 0;
  if (prep.product?._id) {
    const filter = { product: prep.product._id, area: 'kitchen' };
    if (outletId) filter.outlet = outletId;
    const stocks = await StockItem.find(filter).lean();
    qtyOnHand = stocks.reduce((s, x) => s + (x.qtyOnHand || 0), 0);
  }
  return { ...prep, qtyOnHand };
};

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// ── listPrepRecipes ──────────────────────────────────────────────────────────
// GET /api/menu/prep-recipes?outlet=<id>
export const listPrepRecipes = async (req, res) => {
  const outletId = resolveOutletId(req);

  const preps = await PrepRecipe.find({ isActive: true })
    .populate('ingredients.product', 'name sku unit kind')
    .populate('product', 'name sku unit kind currentPrice')
    .sort({ name: 1 })
    .lean();

  const prodIds = preps.map((p) => p.product?._id).filter(Boolean);
  const stockFilter = { product: { $in: prodIds }, area: 'kitchen' };
  if (outletId) stockFilter.outlet = outletId;
  const stocks = await StockItem.find(stockFilter).lean();

  const stockMap = {};
  stocks.forEach((s) => {
    const key = s.product.toString();
    stockMap[key] = (stockMap[key] || 0) + (s.qtyOnHand || 0);
  });

  // Locked preps withhold their ingredient composition from the list unless the
  // request carries a valid unlock token. Everything else (name, yield, cost,
  // on-hand, locked flag, ingredient count) stays so the UI can render + badge.
  const unlocked = hasValidUnlock(req);
  const data = preps.map((p) => stripPrepRecipe(
    { ...p, qtyOnHand: stockMap[p.product?._id?.toString()] ?? 0 },
    unlocked,
  ));

  return res.json({ success: true, data });
};

// ── getPrepRecipe (detail) ────────────────────────────────────────────────────
// GET /api/menu/prep-recipes/:id
// Full prep incl. ingredients — but a LOCKED prep only returns its ingredients
// when the caller presents a valid unlock token. Without it the ingredients are
// withheld (the request that would expose them simply never returns them).
export const getPrepRecipe = async (req, res) => {
  const prep = await shapePrep(req.params.id, resolveOutletId(req));
  if (!prep) return res.status(404).json({ success: false, message: 'Prep recipe not found.' });
  return res.json({ success: true, data: stripPrepRecipe(prep, hasValidUnlock(req)) });
};

// ── setPrepLock ───────────────────────────────────────────────────────────────
// PUT /api/menu/prep-recipes/:id/lock   { locked }
// Turning protection ON needs only menu.manage (hiding is always safe, and the
// feature must be enabled first). Turning it OFF reveals the recipe, so it
// requires a valid unlock token (proof the caller knows the password).
export const setPrepLock = async (req, res) => {
  const { id } = req.params;
  const locked = !!req.body.locked;

  const prep = await PrepRecipe.findById(id);
  if (!prep) return res.status(404).json({ success: false, message: 'Prep recipe not found.' });

  if (locked && !(await isRecipeLockEnabled())) {
    return res.status(400).json({ success: false, message: 'Set a recipe password in Settings before locking recipes.' });
  }
  if (!locked && prep.locked && !hasValidUnlock(req)) {
    return res.status(403).json({ success: false, message: 'Enter the recipe password to unlock this prep recipe.' });
  }

  prep.locked = locked;
  await prep.save();

  await AuditLog.create({
    user: req.user.id,
    action: locked ? 'prep_recipe_locked' : 'prep_recipe_unlocked',
    module: 'menu',
    recordId: prep._id,
    after: { name: prep.name, locked },
    ip: req.ip,
  }).catch(() => {});

  logger.info(`Prep recipe ${locked ? 'locked' : 'unlocked'}: "${prep.name}" by ${req.user.email}`);
  return res.json({ success: true, data: { id: prep._id, locked } });
};

// ── createPrepRecipe ─────────────────────────────────────────────────────────
// POST /api/menu/prep-recipes
// Body: { name, category, yieldQty, yieldUnit, ingredients:[{product,qty,unit}] }
export const createPrepRecipe = async (req, res) => {
  const { name, category, yieldQty, yieldUnit, ingredients = [] } = req.body;
  const cleanName = name.trim();

  if (!(await validateIngredientProducts(ingredients))) {
    return res.status(422).json({ success: false, message: 'One or more ingredients reference a product that no longer exists.' });
  }

  const productIds = ingredients.map((i) => i.product);
  if (await wouldCreateCycle(null, productIds)) {
    return res.status(422).json({ success: false, message: 'This prep recipe would create a circular reference (a prep cannot, directly or indirectly, contain itself).' });
  }

  // Backing stockable product (kind:'prep'). Price filled in by recompute.
  const backing = await Product.create({
    name: cleanName,
    category: category?.trim() || 'Prep',
    unit: yieldUnit,
    kind: 'prep',
    defaultPrice: 0,
    currentPrice: 0,
    isActive: true,
    createdBy: req.user.id,
  });

  const prep = await PrepRecipe.create({
    name: cleanName,
    category: category?.trim() || 'Prep',
    product: backing._id,
    yieldQty,
    yieldUnit,
    ingredients: ingredients.map((i) => ({ product: i.product, qty: i.qty, unit: i.unit })),
    createdBy: req.user.id,
  });

  await recomputeAllPrepCosts();

  await AuditLog.create({
    user: req.user.id,
    action: 'prep_recipe_created',
    module: 'menu',
    recordId: prep._id,
    after: { name: cleanName, yieldQty, yieldUnit, ingredientCount: ingredients.length },
    ip: req.ip,
  });

  logger.info(`Prep recipe created: "${cleanName}" (${ingredients.length} ingredients) by ${req.user.email}`);

  const shaped = await shapePrep(prep._id, resolveOutletId(req));
  return res.status(201).json({ success: true, data: shaped });
};

// ── updatePrepRecipe ─────────────────────────────────────────────────────────
// PUT /api/menu/prep-recipes/:id
export const updatePrepRecipe = async (req, res) => {
  const { id } = req.params;
  const { name, category, yieldQty, yieldUnit, ingredients } = req.body;

  const prep = await PrepRecipe.findById(id);
  if (!prep) return res.status(404).json({ success: false, message: 'Prep recipe not found.' });

  // Editing a locked prep would require seeing/overwriting its composition —
  // only allowed with a valid unlock token.
  if (prep.locked && !hasValidUnlock(req)) {
    return res.status(403).json({ success: false, message: 'Enter the recipe password to edit this locked prep recipe.' });
  }

  if (ingredients !== undefined) {
    if (!(await validateIngredientProducts(ingredients))) {
      return res.status(422).json({ success: false, message: 'One or more ingredients reference a product that no longer exists.' });
    }
    if (await wouldCreateCycle(prep._id, ingredients.map((i) => i.product))) {
      return res.status(422).json({ success: false, message: 'This change would create a circular reference between prep recipes.' });
    }
    prep.ingredients = ingredients.map((i) => ({ product: i.product, qty: i.qty, unit: i.unit }));
  }

  if (name !== undefined) prep.name = name.trim();
  if (category !== undefined) prep.category = category?.trim() || 'Prep';
  if (yieldQty !== undefined) prep.yieldQty = yieldQty;
  if (yieldUnit !== undefined) prep.yieldUnit = yieldUnit;

  await prep.save();

  // Keep the backing product's identity fields in sync with the recipe.
  await Product.findByIdAndUpdate(prep.product, {
    $set: { name: prep.name, category: prep.category, unit: prep.yieldUnit },
  });

  await recomputeAllPrepCosts();

  await AuditLog.create({
    user: req.user.id,
    action: 'prep_recipe_updated',
    module: 'menu',
    recordId: prep._id,
    after: { name: prep.name, yieldQty: prep.yieldQty, yieldUnit: prep.yieldUnit, ingredientCount: prep.ingredients.length },
    ip: req.ip,
  });

  logger.info(`Prep recipe updated: "${prep.name}" by ${req.user.email}`);

  const shaped = await shapePrep(prep._id, resolveOutletId(req));
  return res.json({ success: true, data: shaped });
};

// ── deletePrepRecipe ─────────────────────────────────────────────────────────
// DELETE /api/menu/prep-recipes/:id  (hard delete, guarded by references)
export const deletePrepRecipe = async (req, res) => {
  const { id } = req.params;

  const prep = await PrepRecipe.findById(id);
  if (!prep) return res.status(404).json({ success: false, message: 'Prep recipe not found.' });

  // Block deletion while the prep is referenced by a menu item or another prep.
  const usedInMenu = await MenuItem.countDocuments({ 'ingredients.product': prep.product });
  const usedInPrep = await PrepRecipe.countDocuments({ _id: { $ne: prep._id }, 'ingredients.product': prep.product });
  if (usedInMenu > 0 || usedInPrep > 0) {
    const parts = [];
    if (usedInMenu > 0) parts.push(`${usedInMenu} menu item(s)`);
    if (usedInPrep > 0) parts.push(`${usedInPrep} other prep recipe(s)`);
    return res.status(409).json({
      success: false,
      message: `Cannot delete: this prep is still used in ${parts.join(' and ')}. Remove it from those recipes first.`,
    });
  }

  await StockItem.deleteMany({ product: prep.product });
  await Product.deleteOne({ _id: prep.product });
  await PrepRecipe.deleteOne({ _id: prep._id });

  await recomputeAllPrepCosts();

  await AuditLog.create({
    user: req.user.id,
    action: 'prep_recipe_deleted',
    module: 'menu',
    recordId: prep._id,
    before: { name: prep.name },
    after: null,
    ip: req.ip,
  });

  logger.info(`Prep recipe deleted: "${prep.name}" by ${req.user.email}`);

  return res.json({ success: true, message: 'Prep recipe deleted.' });
};

// ── producePrepBatch ─────────────────────────────────────────────────────────
// POST /api/menu/prep-recipes/:id/produce
// Body: { batches, outlet }
// Deducts the IMMEDIATE ingredients' stock and adds the finished prep to stock.
// Short/missing ingredient stock is allowed (goes negative) and surfaced as a
// warning — matching the soft stock-out behaviour of raw recipe deduction.
export const producePrepBatch = async (req, res) => {
  const { id } = req.params;
  const batches = Number(req.body.batches) || 0;
  if (batches <= 0) {
    return res.status(422).json({ success: false, message: 'Enter how many batches to produce (greater than zero).' });
  }

  const prep = await PrepRecipe.findById(id)
    .populate('ingredients.product', 'name unit currentPrice')
    .populate('product', 'name unit currentPrice')
    .lean();
  if (!prep) return res.status(404).json({ success: false, message: 'Prep recipe not found.' });

  // Resolve a concrete outlet (query/body → user's outlet → first active). We
  // MUST have one before touching stock — otherwise the finished-prep upsert
  // would insert an orphan null-outlet row that no outlet-scoped query ever
  // matches, silently losing the produced stock.
  let outletId = resolveOutletId(req);
  if (!outletId) {
    const firstOutlet = await Outlet.findOne({ isActive: true }).select('_id').lean();
    if (firstOutlet) outletId = firstOutlet._id;
  }
  if (!outletId) {
    return res.status(422).json({ success: false, message: 'No outlet available to produce into. Configure an active outlet first.' });
  }
  const warnings = [];
  const movements = []; // stock ledger rows (prep runs in the kitchen)

  // Deduct each immediate ingredient (raw product or sub-prep) from the kitchen.
  for (const ing of prep.ingredients || []) {
    const prod = ing.product;
    if (!prod) continue;
    const stockUnit = prod.unit || ing.unit;
    const { qty: qtyInStockUnit, converted } = convertQty(ing.qty * batches, ing.unit, stockUnit);
    if (!converted) {
      warnings.push(`Unit mismatch for "${prod.name}" (${ing.unit} → ${stockUnit}); deducted 1:1.`);
    }

    const filter = { product: prod._id, outlet: outletId, area: 'kitchen' };
    const updated = await StockItem.findOneAndUpdate(
      filter,
      { $inc: { qtyOnHand: -qtyInStockUnit } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      warnings.push(`No stock record for "${prod.name}" — produce a batch reduced nothing for it.`);
    } else {
      movements.push({
        product: prod._id,
        outlet: outletId,
        area: 'kitchen',
        qty: -qtyInStockUnit,
        unit: stockUnit,
        type: 'prep-out',
        unitCost: prod.currentPrice || 0,
        ref: { kind: 'prepRecipe', id: prep._id },
        user: req.user.id,
      });
      if (updated.qtyOnHand < 0) {
        warnings.push(`"${prod.name}" is now negative (${round2(updated.qtyOnHand)} ${stockUnit}). Restock soon.`);
      }
    }
  }

  // Add the finished prep to the kitchen (create the row if it doesn't exist yet).
  const producedQty = round2(prep.yieldQty * batches);
  const finishedFilter = { product: prep.product._id, outlet: outletId, area: 'kitchen' };
  const finished = await StockItem.findOneAndUpdate(
    finishedFilter,
    { $inc: { qtyOnHand: producedQty }, $setOnInsert: { product: prep.product._id, outlet: outletId, unit: prep.yieldUnit, area: 'kitchen' } },
    { returnDocument: 'after', upsert: true }
  );

  movements.push({
    product: prep.product._id,
    outlet: outletId,
    area: 'kitchen',
    qty: producedQty,
    unit: prep.yieldUnit,
    type: 'prep-in',
    unitCost: prep.product.currentPrice || 0,
    ref: { kind: 'prepRecipe', id: prep._id },
    user: req.user.id,
  });

  await recordStockMovements(movements);

  await AuditLog.create({
    user: req.user.id,
    action: 'prep_recipe_produced',
    module: 'menu',
    recordId: prep._id,
    after: { name: prep.name, batches, producedQty, outlet: outletId },
    ip: req.ip,
  });

  logger.info(`Prep produced: ${batches} batch(es) of "${prep.name}" (+${producedQty} ${prep.yieldUnit}) by ${req.user.email}`);

  return res.json({
    success: true,
    data: { producedQty, qtyOnHand: round2(finished.qtyOnHand), warnings },
  });
};
