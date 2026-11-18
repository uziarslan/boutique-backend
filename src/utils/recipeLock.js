import jwt from 'jsonwebtoken';
import RecipeLockConfig from '../models/RecipeLockConfig.js';

// How long a single "unlock" lasts once the correct password is entered. The
// frontend keeps the token in sessionStorage, so it is effectively cleared on
// tab close; this cap bounds it server-side regardless.
export const UNLOCK_TTL = '8h';

// Distinguishes an unlock token from a normal auth JWT — both are signed with
// JWT_SECRET, so we MUST check this claim before trusting one to reveal recipes.
const UNLOCK_PURPOSE = 'recipe-unlock';

// Header the client sends the unlock token in.
export const UNLOCK_HEADER = 'x-recipe-unlock';

// Sign a short-lived unlock token bound to the caller's tenant. Global scope:
// one token unlocks any locked recipe in that tenant for its lifetime.
export const signUnlockToken = (req) =>
  jwt.sign(
    { purpose: UNLOCK_PURPOSE, tenantSlug: req.tenantSlug, uid: String(req.user?.id ?? '') },
    process.env.JWT_SECRET,
    { expiresIn: UNLOCK_TTL }
  );

// True iff the request carries a valid, unexpired unlock token for THIS tenant.
// A recipe's ingredients may only be returned when this is true (or the recipe
// isn't locked). Tenant binding stops a token minted in tenant A from unlocking
// tenant B's recipes.
export const hasValidUnlock = (req) => {
  const raw = req.headers?.[UNLOCK_HEADER];
  if (!raw || typeof raw !== 'string') return false;
  try {
    const decoded = jwt.verify(raw, process.env.JWT_SECRET);
    return decoded?.purpose === UNLOCK_PURPOSE && decoded?.tenantSlug === req.tenantSlug;
  } catch {
    return false;
  }
};

// Feature is ON only when a master password has been set.
export const isRecipeLockEnabled = async () => {
  const cfg = await RecipeLockConfig.findOne().lean();
  return !!cfg?.passwordHash;
};

// Strip a menu item's recipe composition when it's locked and the caller hasn't
// unlocked. Mutates + returns the (lean) item. Keeps variation name/price so the
// menu still renders; only the ingredient arrays (the actual recipe) are hidden.
// `recipeIngredientCount` is preserved so the UI can show "N ingredients (locked)".
export const stripMenuItemRecipe = (item, unlocked) => {
  if (!item || !item.recipeLocked || unlocked) return item;
  const itemCount = Array.isArray(item.ingredients) ? item.ingredients.length : 0;
  const varCount = Array.isArray(item.variations)
    ? item.variations.reduce((s, v) => s + (Array.isArray(v?.ingredients) ? v.ingredients.length : 0), 0)
    : 0;
  item.recipeIngredientCount = itemCount + varCount;
  item.ingredients = [];
  if (Array.isArray(item.variations)) {
    item.variations = item.variations.map((v) => ({ ...v, ingredients: [] }));
  }
  return item;
};

// Strip a prep recipe's ingredient composition when locked and not unlocked.
export const stripPrepRecipe = (prep, unlocked) => {
  if (!prep || !prep.locked || unlocked) return prep;
  prep.ingredientCount = Array.isArray(prep.ingredients) ? prep.ingredients.length : 0;
  prep.ingredients = [];
  return prep;
};
