import MenuCategory from '../models/MenuCategory.js';
import MenuItem from '../models/MenuItem.js';
import Product from '../models/Product.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { uploadImage, deleteImage } from '../cloudinary/index.js';
import { hasValidUnlock, stripMenuItemRecipe } from '../utils/recipeLock.js';
import { validateDealConfiguration } from '../services/deal.service.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

// ── getCategories ──────────────────────────────────────────────────────────────
// GET /api/menu/categories?outletId=<id>  OR  ?outlet=<id>

export const getCategories = async (req, res) => {
  const { outletId, outlet } = req.query;
  const outletParam = outletId || outlet;

  if (!outletParam) {
    return res.status(422).json({ success: false, message: 'outletId (or outlet) query param is required.' });
  }

  const categories = await MenuCategory.find({ outlet: outletParam })
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  return res.json({ success: true, data: categories });
};

// ── createCategory ─────────────────────────────────────────────────────────────
// POST /api/menu/categories

export const createCategory = async (req, res) => {
  const { name, outlet, sortOrder, color, isActive } = req.body;

  const category = await MenuCategory.create({
    name,
    outlet,
    sortOrder,
    color,
    isActive,
    createdBy: req.user.id,
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_category_created',
    module: 'menu',
    recordId: category._id,
    after: { name: category.name, outlet, sortOrder, color },
    ip: req.ip,
  });

  logger.info(`Menu category created: "${category.name}" (outlet ${outlet}) by ${req.user.email}`);

  return res.status(201).json({ success: true, data: category });
};

// ── updateCategory ─────────────────────────────────────────────────────────────
// PATCH /api/menu/categories/:id

export const updateCategory = async (req, res) => {
  const category = await MenuCategory.findById(req.params.id);

  if (!category) {
    return res.status(404).json({ success: false, message: 'Category not found.' });
  }

  const before = {
    name: category.name,
    sortOrder: category.sortOrder,
    color: category.color,
    isActive: category.isActive,
  };

  const allowedFields = ['name', 'sortOrder', 'color', 'isActive'];
  allowedFields.forEach((f) => {
    if (req.body[f] !== undefined) category[f] = req.body[f];
  });

  await category.save();

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_category_updated',
    module: 'menu',
    recordId: category._id,
    before,
    after: { name: category.name, sortOrder: category.sortOrder, color: category.color, isActive: category.isActive },
    ip: req.ip,
  });

  return res.json({ success: true, data: category });
};

// ── deleteCategory ─────────────────────────────────────────────────────────────
// DELETE /api/menu/categories/:id  (soft delete)

export const deleteCategory = async (req, res) => {
  const category = await MenuCategory.findById(req.params.id);

  if (!category) {
    return res.status(404).json({ success: false, message: 'Category not found.' });
  }

  // Reject if any active menu items still belong to this category
  const activeItemCount = await MenuItem.countDocuments({
    category: category._id,
    isAvailable: true,
  });

  if (activeItemCount > 0) {
    return res.status(409).json({
      success: false,
      message: `Cannot deactivate category: ${activeItemCount} active item(s) still assigned to it. ` +
        'Mark those items as unavailable first.',
    });
  }

  // If caller requests a hard delete, remove the category document entirely.
  if (req.query.hard === 'true') {
    const totalItems = await MenuItem.countDocuments({ category: category._id });
    if (totalItems > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete category: ${totalItems} item(s) still reference this category. Reassign or delete those items first.`,
      });
    }

    try {
      await MenuCategory.deleteOne({ _id: category._id });

      await AuditLog.create({
        user: req.user.id,
        action: 'menu_category_deleted',
        module: 'menu',
        recordId: category._id,
        before: { name: category.name, isActive: category.isActive },
        after: null,
        ip: req.ip,
      });

      logger.info(`Menu category deleted: "${category.name}" by ${req.user.email}`);

      return res.json({ success: true, message: 'Category deleted.' });
    } catch (err) {
      logger.error(`Failed to delete category ${req.params.id}: ${err.message}`);
      return res.status(500).json({ success: false, message: 'Failed to delete category.' });
    }
  }

  try {
    category.isActive = false;
    const saved = await category.save();

    await AuditLog.create({
      user: req.user.id,
      action: 'menu_category_deactivated',
      module: 'menu',
      recordId: category._id,
      before: { isActive: true },
      after: { isActive: false },
      ip: req.ip,
    });

    logger.info(`Menu category deactivated: "${category.name}" by ${req.user.email}`);

    return res.json({ success: true, message: 'Category deactivated.', data: saved });
  } catch (err) {
    logger.error(`Failed to deactivate category ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to deactivate category.' });
  }
};

// ── createIngredient ────────────────────────────────────────────────────────────
// POST /api/menu/ingredients
// Body: { name, unit, category?, defaultPrice? }
//
// Quick-creates a catalog Product (an ingredient) directly from the Recipe
// Editor so a recipe can reference an ingredient that isn't in inventory yet.
// No StockItem is created — the ingredient is stocked later via the normal
// PO → GRN → invoice-approval flow. Gated by `menu.manage` like the rest of the
// menu module, so recipe editors don't also need `products.manage`.

export const createIngredient = async (req, res) => {
  const { name, unit, category, defaultPrice } = req.body;
  const cleanName = name.trim();

  // Reuse an existing product with the same name (case-insensitive) instead of
  // creating a duplicate catalog entry.
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await Product.findOne({ name: new RegExp(`^${escaped}$`, 'i') }).lean();
  if (existing) {
    return res.json({ success: true, data: existing, message: 'Existing ingredient reused.' });
  }

  const price = Number(defaultPrice) || 0;
  const product = await Product.create({
    name: cleanName,
    unit,
    category: category?.trim() || 'General',
    defaultPrice: price,
    currentPrice: price,
    isActive: true,
    createdBy: req.user.id,
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_ingredient_created',
    module: 'menu',
    recordId: product._id,
    after: { name: product.name, unit: product.unit, category: product.category },
    ip: req.ip,
  });

  logger.info(`Ingredient created from recipe editor: "${product.name}" (${product.sku}) by ${req.user.email}`);

  return res.status(201).json({ success: true, data: product });
};

// ═══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS
// ═══════════════════════════════════════════════════════════════════════════════

// ── getAllMenuItems ────────────────────────────────────────────────────────────
// GET /api/menu/items?outletId=<id>&category=<id>&isAvailable=true&page=1&limit=20

export const getAllMenuItems = async (req, res) => {
  const { outletId, outlet, category, isAvailable, search, page = 1, limit = 20 } = req.query;
  const outletParam = outletId || outlet;

  if (!outletParam) {
    return res.status(422).json({ success: false, message: 'outletId (or outlet) query param is required.' });
  }

  const pageNum = Math.max(1, parseInt(page, 10));
  // The management Menu screen paginates WITHIN the selected category (20/page),
  // so totals come from a separate stats endpoint and this list stays bounded.
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = { outlet: outletParam };
  if (category) {
    filter.category = category;
  }

  if (isAvailable !== undefined && isAvailable !== 'all') {
    filter.isAvailable = isAvailable === 'true';
  }

  // Free-text search over name + SKU, scoped by the same outlet/category filter
  // so results paginate across ALL matches — not just the current page's rows.
  if (search && String(search).trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    filter.$or = [{ name: rx }, { sku: rx }];
  }

  const [items, total] = await Promise.all([
    MenuItem.find(filter)
      .populate('category', 'name color sortOrder')
      .populate('dealConfig.fixedItems.menuItem', 'name itemType price isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
      .populate('dealConfig.choiceGroups.options.menuItem', 'name itemType price isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
      // Sort on the item's OWN fields (populate runs after the query, so a
      // `category.sortOrder` key would be a no-op). `category` groups rows for the
      // all-categories path; `_id` is a unique tiebreaker so skip/limit paging is
      // stable even when two items share a name (e.g. duplicate "… Pasta").
      .sort({ category: 1, sortOrder: 1, name: 1, _id: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    MenuItem.countDocuments(filter),
  ]);

  // The list returns full item docs, which include embedded recipe ingredients.
  // Strip the composition of any locked item unless the caller is unlocked — the
  // lock badge (recipeLocked) + ingredient count still ride along.
  const unlocked = hasValidUnlock(req);
  const safeItems = items.map((it) => stripMenuItemRecipe(it, unlocked));

  return res.json({
    success: true,
    data: safeItems,
    pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
  });
};

// ── getMenuItemStats ─────────────────────────────────────────────────────────────
// GET /api/menu/items/stats?outletId=<id>
// Outlet-wide counts for the Menu dashboard cards. Kept separate so the item
// list can paginate per-category (20/page) without loading every item just to
// show totals.

export const getMenuItemStats = async (req, res) => {
  const { outletId, outlet } = req.query;
  const outletParam = outletId || outlet;

  if (!outletParam) {
    return res.status(422).json({ success: false, message: 'outletId (or outlet) query param is required.' });
  }

  const [total, available, tracked] = await Promise.all([
    MenuItem.countDocuments({ outlet: outletParam }),
    MenuItem.countDocuments({ outlet: outletParam, isAvailable: true }),
    MenuItem.countDocuments({ outlet: outletParam, trackInventory: true }),
  ]);

  return res.json({ success: true, data: { total, available, tracked } });
};

// ── createMenuItem ─────────────────────────────────────────────────────────────
// POST /api/menu/items

export const createMenuItem = async (req, res) => {
  const {
    name, category, price, foodPandaPrice, priceMode, taxRate, serviceCharge,
    description, imageUrl, isAvailable, isAvailableForQrOrder, sortOrder, variations,
    itemType = 'regular', dealConfig,
  } = req.body;
  const praItem = {
    itemCode: String(req.body.pra?.itemCode || '').trim().slice(0, 50),
    pctCode: String(req.body.pra?.pctCode || '').replace(/[.\s-]/g, '').slice(0, 8),
  };
  if (praItem.pctCode && !/^\d{8}$/.test(praItem.pctCode)) {
    return res.status(422).json({ success: false, message: 'PRA item PCT code must contain exactly 8 digits.' });
  }

  // The category is per-outlet, so the category's outlet is the authoritative
  // owner of the item. Deriving item.outlet from it (instead of trusting a
  // separately-sent body.outlet) guarantees item.outlet never drifts from the
  // menu the item actually appears on — which is what caused the management
  // list and the POS to disagree.
  const catDoc = await MenuCategory.findById(category).select('outlet').lean();
  if (!catDoc) {
    return res.status(422).json({ success: false, message: 'Category not found.' });
  }
  const outlet = catDoc.outlet;

  if (itemType === 'deal') {
    if (Array.isArray(variations) && variations.length) {
      return res.status(422).json({ success: false, message: 'Deals cannot have size variations. Add sizes to their component items instead.' });
    }
    await validateDealConfiguration({ dealConfig, outletId: outlet });
  }

  // New variations carry only name + price; their recipes are authored later via
  // the Recipe Editor, so each starts with an empty ingredient list.
  const variationDocs = Array.isArray(variations)
    ? variations.map((v, i) => ({
        name: v.name,
        price: v.price,
        foodPandaPrice: v.foodPandaPrice ?? null,
        sortOrder: v.sortOrder ?? i,
        ingredients: [],
      }))
    : [];
  // The model requires a base price; when sizes exist it's just a representative
  // value (lowest size) for list display — the chosen variation drives pricing.
  const basePrice = (price !== undefined && price !== null)
    ? price
    : (variationDocs.length ? Math.min(...variationDocs.map((v) => v.price)) : 0);

  // trackInventory is managed entirely by the Recipe Editor. New items start with
  // no tracking until a recipe is saved.
  const item = await MenuItem.create({
    name, outlet, category,
    itemType,
    dealConfig: itemType === 'deal' ? dealConfig : { fixedItems: [], choiceGroups: [] },
    price: basePrice, foodPandaPrice: foodPandaPrice ?? null, priceMode, taxRate, serviceCharge, description, imageUrl,
    isAvailable, isAvailableForQrOrder, trackInventory: false, sortOrder,
    variations: variationDocs,
    pra: praItem,
    createdBy: req.user.id,
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_item_created',
    module: 'menu',
    recordId: item._id,
    after: {
      name: item.name,
      outlet,
      category,
      price: basePrice,
      foodPandaPrice: item.foodPandaPrice,
      priceMode: item.priceMode,
      isAvailable: item.isAvailable,
      isAvailableForQrOrder: item.isAvailableForQrOrder,
      variationCount: variationDocs.length,
      itemType,
    },
    ip: req.ip,
  });

  logger.info(`Menu item created: "${item.name}" (outlet ${outlet}) by ${req.user.email}`);

  return res.status(201).json({ success: true, data: item });
};

// ── updateMenuItem ─────────────────────────────────────────────────────────────
// PATCH /api/menu/items/:id

export const updateMenuItem = async (req, res) => {
  const item = await MenuItem.findById(req.params.id);

  if (!item) {
    return res.status(404).json({ success: false, message: 'Menu item not found.' });
  }
  const hadVariationRecipes = (item.variations || []).some((variation) => (
    (variation.ingredients?.length ?? 0) > 0
  ));

  const before = {
    name: item.name, price: item.price, foodPandaPrice: item.foodPandaPrice, priceMode: item.priceMode,
    taxRate: item.taxRate, isAvailable: item.isAvailable,
    isAvailableForQrOrder: item.isAvailableForQrOrder,
    category: item.category,
  };

  // trackInventory, sku and linkedProduct are managed by the Recipe Editor,
  // not this endpoint. Ignore them if the client sends them. `variations` is
  // merged separately below so per-variation recipes survive metadata edits.
  const allowedFields = [
    'name', 'category', 'price', 'foodPandaPrice', 'priceMode', 'taxRate', 'serviceCharge', 'description',
    'imageUrl', 'isAvailable', 'isAvailableForQrOrder', 'sortOrder',
  ];
  allowedFields.forEach((f) => {
    if (req.body[f] !== undefined) item[f] = req.body[f];
  });
  if (req.body.pra !== undefined) {
    const itemCode = String(req.body.pra?.itemCode || '').trim().slice(0, 50);
    const pctCode = String(req.body.pra?.pctCode || '').replace(/[.\s-]/g, '').slice(0, 8);
    if (pctCode && !/^\d{8}$/.test(pctCode)) {
      return res.status(422).json({ success: false, message: 'PRA item PCT code must contain exactly 8 digits.' });
    }
    item.pra = { itemCode, pctCode };
  }

  // Merge variations by _id so renaming / repricing a size never wipes the
  // recipe that was authored for it. New entries (no _id) start empty; entries
  // dropped from the payload are removed along with their recipe.
  if (req.body.variations !== undefined) {
    const incoming = Array.isArray(req.body.variations) ? req.body.variations : [];
    const existingById = new Map((item.variations || []).map((v) => [v._id.toString(), v]));
    item.variations = incoming.map((v, i) => {
      const existing = v._id ? existingById.get(v._id.toString()) : null;
      return {
        ...(existing ? { _id: existing._id } : {}),
        name: v.name,
        price: v.price,
        foodPandaPrice: v.foodPandaPrice ?? null,
        sortOrder: v.sortOrder ?? i,
        ingredients: existing ? existing.ingredients.toObject() : [],
      };
    });
    // Representative base price = lowest size (model requires a price); leave the
    // client/base price untouched when all sizes were removed.
    if (item.variations.length) {
      item.price = Math.min(...item.variations.map((v) => v.price));
    }
    // Removing a size may drop its recipe — keep trackInventory in sync.
    item.trackInventory = (item.ingredients?.length ?? 0) > 0
      || item.variations.some((v) => (v.ingredients?.length ?? 0) > 0);
  }

  // Keep item.outlet in lockstep with its category's outlet when the category
  // changes, so the item can never drift to a different outlet than its menu.
  if (req.body.category !== undefined) {
    const catDoc = await MenuCategory.findById(item.category).select('outlet').lean();
    if (catDoc) item.outlet = catDoc.outlet;
    const containingDeal = await MenuItem.findOne({
      _id: { $ne: item._id },
      $or: [
        { 'dealConfig.fixedItems.menuItem': item._id },
        { 'dealConfig.choiceGroups.options.menuItem': item._id },
      ],
    }).select('name outlet').lean();
    if (containingDeal && containingDeal.outlet.toString() !== item.outlet.toString()) {
      return res.status(409).json({
        success: false,
        message: `This item is used inside the deal "${containingDeal.name}" and cannot be moved to another outlet.`,
      });
    }
  }

  const nextItemType = req.body.itemType ?? item.itemType ?? 'regular';
  if (nextItemType === 'deal') {
    if (item.itemType !== 'deal') {
      const containingDeal = await MenuItem.findOne({
        _id: { $ne: item._id },
        $or: [
          { 'dealConfig.fixedItems.menuItem': item._id },
          { 'dealConfig.choiceGroups.options.menuItem': item._id },
        ],
      }).select('name').lean();
      if (containingDeal) {
        return res.status(409).json({
          success: false,
          message: `This item is used inside the deal "${containingDeal.name}" and cannot itself be converted into a deal.`,
        });
      }
    }
    if (hadVariationRecipes) {
      return res.status(422).json({ success: false, message: 'Remove the existing size recipes before converting this item into a deal. Deal inventory comes from its component items.' });
    }
    if ((item.variations?.length ?? 0) > 0) {
      return res.status(422).json({ success: false, message: 'Deals cannot have size variations. Remove the deal item sizes first.' });
    }
    if ((item.ingredients?.length ?? 0) > 0) {
      return res.status(422).json({ success: false, message: 'Remove the item-level recipe before converting this item into a deal. Deal inventory comes from its component items.' });
    }
    const nextDealConfig = req.body.dealConfig ?? item.dealConfig?.toObject?.() ?? item.dealConfig;
    await validateDealConfiguration({
      dealConfig: nextDealConfig,
      outletId: item.outlet,
      itemId: item._id,
    });
    item.itemType = 'deal';
    item.dealConfig = nextDealConfig;
    item.trackInventory = false;
  } else if (req.body.itemType !== undefined) {
    item.itemType = 'regular';
    item.dealConfig = { fixedItems: [], choiceGroups: [] };
  }

  await item.save();

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_item_updated',
    module: 'menu',
    recordId: item._id,
    before,
    after: {
      name: item.name,
      price: item.price,
      foodPandaPrice: item.foodPandaPrice,
      isAvailable: item.isAvailable,
      isAvailableForQrOrder: item.isAvailableForQrOrder,
      itemType: item.itemType,
    },
    ip: req.ip,
  });

  // Metadata edits (name/price/availability) are allowed on a locked item, but
  // the response must not leak its recipe composition back to an un-unlocked caller.
  return res.json({ success: true, data: stripMenuItemRecipe(item.toObject(), hasValidUnlock(req)) });
};

// ── deleteMenuItem ─────────────────────────────────────────────────────────────
// DELETE /api/menu/items/:id  (soft delete — sets isAvailable: false)

export const deleteMenuItem = async (req, res) => {
  const item = await MenuItem.findById(req.params.id);

  if (!item) {
    return res.status(404).json({ success: false, message: 'Menu item not found.' });
  }
  // If caller requests a hard delete, remove the document entirely.
  if (req.query.hard === 'true') {
    const referencedByDeal = await MenuItem.findOne({
      _id: { $ne: item._id },
      $or: [
        { 'dealConfig.fixedItems.menuItem': item._id },
        { 'dealConfig.choiceGroups.options.menuItem': item._id },
      ],
    }).select('name').lean();
    if (referencedByDeal) {
      return res.status(409).json({
        success: false,
        message: `Cannot permanently delete this item because it is used in the deal "${referencedByDeal.name}". Remove it from that deal first.`,
      });
    }
    const before = { name: item.name, isAvailable: item.isAvailable, sku: item.sku };

    // Best-effort: remove the associated image from Cloudinary. A failure here
    // must not block deletion of the menu item itself.
    if (item.imagePublicId) {
      try {
        await deleteImage(item.imagePublicId);
      } catch (err) {
        logger.error(`Failed to delete Cloudinary image for menu item ${item._id}: ${err.message}`);
      }
    }

    await MenuItem.deleteOne({ _id: item._id });

    await AuditLog.create({
      user: req.user.id,
      action: 'menu_item_deleted',
      module: 'menu',
      recordId: item._id,
      before,
      after: null,
      ip: req.ip,
    });

    logger.info(`Menu item deleted: "${item.name}" by ${req.user.email}`);

    return res.json({ success: true, message: 'Menu item deleted.' });
  }

  // Default behaviour: soft-delete by marking unavailable
  item.isAvailable = false;
  await item.save();

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_item_deactivated',
    module: 'menu',
    recordId: item._id,
    before: { isAvailable: true },
    after: { isAvailable: false },
    ip: req.ip,
  });

  logger.info(`Menu item deactivated: "${item.name}" by ${req.user.email}`);

  return res.json({ success: true, message: 'Menu item marked as unavailable.' });
};

// ── uploadMenuItemImage ────────────────────────────────────────────────────────
// POST /api/menu/items/:id/image  (multipart/form-data, field: "image")
// Uploads to restaurant-management/<tenantSlug> and replaces any existing image.

export const uploadMenuItemImage = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file uploaded.' });
  }

  const item = await MenuItem.findById(req.params.id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'Menu item not found.' });
  }

  const previousPublicId = item.imagePublicId;

  let uploaded;
  try {
    uploaded = await uploadImage(req.file.buffer, req.tenantSlug);
  } catch (err) {
    logger.error(`Cloudinary upload failed for menu item ${item._id}: ${err.message}`);
    return res.status(502).json({ success: false, message: 'Image upload failed. Please try again.' });
  }

  item.imageUrl = uploaded.url;
  item.imagePublicId = uploaded.publicId;
  await item.save();

  // Replace succeeded — best-effort cleanup of the old asset.
  if (previousPublicId && previousPublicId !== uploaded.publicId) {
    try {
      await deleteImage(previousPublicId);
    } catch (err) {
      logger.error(`Failed to delete previous Cloudinary image ${previousPublicId}: ${err.message}`);
    }
  }

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_item_image_updated',
    module: 'menu',
    recordId: item._id,
    after: { imageUrl: item.imageUrl },
    ip: req.ip,
  });

  logger.info(`Menu item image updated: "${item.name}" by ${req.user.email}`);

  return res.json({ success: true, data: { imageUrl: item.imageUrl, imagePublicId: item.imagePublicId } });
};

// ── deleteMenuItemImage ─────────────────────────────────────────────────────────
// DELETE /api/menu/items/:id/image  — removes the image from Cloudinary and the item.

export const deleteMenuItemImage = async (req, res) => {
  const item = await MenuItem.findById(req.params.id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'Menu item not found.' });
  }

  if (item.imagePublicId) {
    try {
      await deleteImage(item.imagePublicId);
    } catch (err) {
      logger.error(`Failed to delete Cloudinary image for menu item ${item._id}: ${err.message}`);
    }
  }

  item.imageUrl = undefined;
  item.imagePublicId = undefined;
  await item.save();

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_item_image_removed',
    module: 'menu',
    recordId: item._id,
    ip: req.ip,
  });

  return res.json({ success: true, message: 'Image removed.' });
};

// ── bulkUpdateAvailability ─────────────────────────────────────────────────────
// PATCH /api/menu/items/bulk-availability
// Body: { items: [{ id, isAvailable }] }
// Used for quickly "86ing" multiple items (marking them unavailable mid-service).

export const bulkUpdateAvailability = async (req, res) => {
  const { items } = req.body;

  const ops = items.map(({ id, isAvailable }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { isAvailable } },
    },
  }));

  const result = await MenuItem.bulkWrite(ops, { ordered: false });

  await AuditLog.create({
    user: req.user.id,
    action: 'menu_items_bulk_availability',
    module: 'menu',
    after: { itemCount: items.length, changes: items },
    ip: req.ip,
  });

  logger.info(`Bulk availability update: ${items.length} items by ${req.user.email}`);

  return res.json({
    success: true,
    message: `Updated ${result.modifiedCount} item(s).`,
    data: { matched: result.matchedCount, modified: result.modifiedCount },
  });
};
