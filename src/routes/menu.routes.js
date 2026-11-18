import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import authorize from '../middleware/role.middleware.js';
import { validate } from '../validators/menu.validator.js';
import {
  createCategorySchema,
  updateCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  bulkAvailabilitySchema,
  createIngredientSchema,
  createPrepRecipeSchema,
  updatePrepRecipeSchema,
  producePrepBatchSchema,
  saveRecipeSchema,
} from '../validators/menu.validator.js';
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getAllMenuItems,
  getMenuItemStats,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  uploadMenuItemImage,
  deleteMenuItemImage,
  bulkUpdateAvailability,
  createIngredient,
} from '../controllers/menuManagement.controller.js';
import { uploadMenuImage } from '../middleware/upload.middleware.js';
import reattachTenant from '../middleware/reattachTenant.middleware.js';
import {
  getRecipe,
  saveRecipe,
  deleteRecipeIngredient,
  recordUsage,
  setMenuRecipeLock,
} from '../controllers/recipe.controller.js';
import {
  listPrepRecipes,
  getPrepRecipe,
  createPrepRecipe,
  updatePrepRecipe,
  deletePrepRecipe,
  producePrepBatch,
  setPrepLock,
} from '../controllers/prepRecipe.controller.js';
import {
  getStatus as getRecipeLockStatus,
  setPassword as setRecipeLockPassword,
  disableLock as disableRecipeLock,
  lockAllRecipes,
  unlockAllRecipes,
  verifyPassword as verifyRecipeLockPassword,
} from '../controllers/recipeLock.controller.js';

const router = Router();

// All menu management routes require a valid JWT and the `menu.manage` permission.
// This allows owners by default and also enables per-user overrides.
router.use(protect, requirePermission('menu.manage'));

// ─── Categories ───────────────────────────────────────────────────────────────
router.get('/categories', getCategories);
router.post('/categories', validate(createCategorySchema), createCategory);
router.patch('/categories/:id', validate(updateCategorySchema), updateCategory);
router.delete('/categories/:id', deleteCategory);

// ─── Items ────────────────────────────────────────────────────────────────────
// Bulk route must come before /:id to avoid 'bulk-availability' being parsed as an id
router.patch('/items/bulk-availability', validate(bulkAvailabilitySchema), bulkUpdateAvailability);

// Static sub-route must precede the generic /items list so it isn't shadowed.
router.get('/items/stats', getMenuItemStats);
router.get('/items', getAllMenuItems);
router.post('/items', validate(createMenuItemSchema), createMenuItem);
router.patch('/items/:id', validate(updateMenuItemSchema), updateMenuItem);
router.delete('/items/:id', deleteMenuItem);

// ─── Item image (Cloudinary) ──────────────────────────────────────────────────
// Multer runs before the async handler; forward any upload error via next(err).
router.post(
  '/items/:id/image',
  (req, res, next) => {
    uploadMenuImage(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  // multer's async parsing drops the tenant context — restore it before the
  // controller touches tenant-scoped models.
  reattachTenant,
  uploadMenuItemImage
);
router.delete('/items/:id/image', deleteMenuItemImage);

// ─── Ingredients (catalog products usable in recipes, stocked later) ──────────
router.post('/ingredients', validate(createIngredientSchema), createIngredient);

// ─── Recipe Lock (tenant-wide password protecting locked recipes) ─────────────
// Placed before the parameterised recipe/prep routes so the literal path wins.
// status/verify: any menu manager. password set/disable: owner only.
router.get('/recipe-lock/status', getRecipeLockStatus);
router.post('/recipe-lock/verify', verifyRecipeLockPassword);
router.post('/recipe-lock/password', authorize('owner'), setRecipeLockPassword);
router.delete('/recipe-lock/password', authorize('owner'), disableRecipeLock);
router.put('/recipe-lock/all', authorize('owner'), lockAllRecipes);
router.put('/recipe-lock/all/unlock', authorize('owner'), unlockAllRecipes);

// ─── Prep Recipes (reusable in-house preparations: marination, sauces…) ───────
router.get('/prep-recipes', listPrepRecipes);
router.get('/prep-recipes/:id', getPrepRecipe);
router.post('/prep-recipes', validate(createPrepRecipeSchema), createPrepRecipe);
router.put('/prep-recipes/:id/lock', setPrepLock);
router.put('/prep-recipes/:id', validate(updatePrepRecipeSchema), updatePrepRecipe);
router.delete('/prep-recipes/:id', deletePrepRecipe);
router.post('/prep-recipes/:id/produce', validate(producePrepBatchSchema), producePrepBatch);

// ─── Recipe (ingredient linkage) per menu item ────────────────────────────────
router.get('/items/:itemId/recipe', getRecipe);
router.put('/items/:itemId/recipe/lock', setMenuRecipeLock);
router.put('/items/:itemId/recipe', validate(saveRecipeSchema), saveRecipe);
router.delete('/items/:itemId/recipe/:ingredientId', deleteRecipeIngredient);
router.post('/items/:itemId/recipe/usage', recordUsage);

export default router;
