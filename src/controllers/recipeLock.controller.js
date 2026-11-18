import bcrypt from 'bcryptjs';
import RecipeLockConfig from '../models/RecipeLockConfig.js';
import MenuItem from '../models/MenuItem.js';
import PrepRecipe from '../models/PrepRecipe.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { signUnlockToken } from '../utils/recipeLock.js';

const MIN_PASSWORD_LEN = 4;

// GET /api/menu/recipe-lock/status
// Any menu manager may ask whether the feature is on (so the UI can show/hide
// lock controls). Never returns the hash — only a boolean.
export const getStatus = async (_req, res) => {
  const [cfg, menuItems, lockedMenuItems, prepRecipes, lockedPrepRecipes] = await Promise.all([
    RecipeLockConfig.findOne().lean(),
    MenuItem.countDocuments(),
    MenuItem.countDocuments({ recipeLocked: true }),
    PrepRecipe.countDocuments(),
    PrepRecipe.countDocuments({ locked: true }),
  ]);
  const totalRecipes = menuItems + prepRecipes;
  const lockedRecipes = lockedMenuItems + lockedPrepRecipes;

  return res.json({
    success: true,
    data: {
      enabled: !!cfg?.passwordHash,
      allLocked: totalRecipes > 0 && lockedRecipes === totalRecipes,
      totalRecipes,
      lockedRecipes,
    },
  });
};

// POST /api/menu/recipe-lock/password   { newPassword, currentPassword? }
// Owner only. The first password can be set directly; changing an existing
// tenant-wide password requires proof of the current one.
export const setPassword = async (req, res) => {
  const { newPassword, currentPassword } = req.body;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length < MIN_PASSWORD_LEN) {
    return res.status(400).json({
      success: false,
      message: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
    });
  }

  let cfg = await RecipeLockConfig.findOne();
  const isFirstTime = !cfg?.passwordHash;

  if (!isFirstTime) {
    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Current recipe password is required.',
      });
    }

    const currentMatches = await bcrypt.compare(currentPassword.trim(), cfg.passwordHash);
    if (!currentMatches) {
      await AuditLog.create({
        user: req.user.id,
        action: 'recipe_lock_password_change_failed',
        module: 'menu',
        recordId: cfg._id,
        ip: req.ip,
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        message: 'Current recipe password is incorrect.',
      });
    }
  }

  const hash = await bcrypt.hash(newPassword.trim(), 12);

  if (!cfg) cfg = new RecipeLockConfig();
  cfg.passwordHash = hash;
  cfg.updatedBy = req.user.id;
  await cfg.save();

  await AuditLog.create({
    user: req.user.id,
    action: isFirstTime ? 'recipe_lock_password_set' : 'recipe_lock_password_changed',
    module: 'menu',
    recordId: cfg._id,
    ip: req.ip,
  }).catch(() => {});

  logger.info(`Recipe-lock password ${isFirstTime ? 'set' : 'changed'} by ${req.user.email}`);
  return res.json({ success: true, data: { enabled: true } });
};

// DELETE /api/menu/recipe-lock/password
// Owner only. Disables the feature: removes the master password AND clears every
// recipe's locked flag, so nothing is left "protected" by a password that no
// longer exists (which would otherwise silently expose those recipes).
export const disableLock = async (req, res) => {
  const { currentPassword } = req.body || {};
  const cfg = await RecipeLockConfig.findOne();
  if (!cfg?.passwordHash) {
    return res.status(400).json({ success: false, message: 'Recipe lock is not enabled.' });
  }

  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Current recipe password is required.',
    });
  }

  const currentMatches = await bcrypt.compare(currentPassword.trim(), cfg.passwordHash);
  if (!currentMatches) {
    await AuditLog.create({
      user: req.user.id,
      action: 'recipe_lock_disable_failed',
      module: 'menu',
      recordId: cfg._id,
      ip: req.ip,
    }).catch(() => {});
    return res.status(400).json({
      success: false,
      message: 'Current recipe password is incorrect.',
    });
  }

  cfg.passwordHash = null;
  cfg.updatedBy = req.user.id;
  await cfg.save();

  const [mi, pr] = await Promise.all([
    MenuItem.updateMany({ recipeLocked: true }, { $set: { recipeLocked: false } }),
    PrepRecipe.updateMany({ locked: true }, { $set: { locked: false } }),
  ]);

  await AuditLog.create({
    user: req.user.id,
    action: 'recipe_lock_disabled',
    module: 'menu',
    recordId: cfg._id,
    after: { menuItemsUnlocked: mi.modifiedCount ?? 0, prepsUnlocked: pr.modifiedCount ?? 0 },
    ip: req.ip,
  }).catch(() => {});

  logger.info(`Recipe-lock disabled by ${req.user.email} (cleared ${mi.modifiedCount ?? 0} items, ${pr.modifiedCount ?? 0} preps)`);
  return res.json({ success: true, data: { enabled: false } });
};

// PUT /api/menu/recipe-lock/all
// Owner only. Applies the tenant-wide password protection to every menu-item
// recipe and every prep recipe in one bulk action. The operation is idempotent:
// recipes that are already locked are left unchanged.
export const lockAllRecipes = async (req, res) => {
  const cfg = await RecipeLockConfig.findOne().lean();
  if (!cfg?.passwordHash) {
    return res.status(400).json({
      success: false,
      message: 'Set a recipe password before locking all recipes.',
    });
  }

  const [mi, pr] = await Promise.all([
    MenuItem.updateMany(
      { recipeLocked: { $ne: true } },
      { $set: { recipeLocked: true } },
    ),
    PrepRecipe.updateMany(
      { locked: { $ne: true } },
      { $set: { locked: true } },
    ),
  ]);

  const menuItemsLocked = mi.modifiedCount ?? 0;
  const prepRecipesLocked = pr.modifiedCount ?? 0;
  const totalLocked = menuItemsLocked + prepRecipesLocked;

  await AuditLog.create({
    user: req.user.id,
    action: 'all_recipes_locked',
    module: 'menu',
    recordId: cfg._id,
    after: { menuItemsLocked, prepRecipesLocked, totalLocked },
    ip: req.ip,
  }).catch(() => {});

  logger.info(
    `All recipes locked by ${req.user.email} (${menuItemsLocked} menu items, ${prepRecipesLocked} preps)`,
  );
  return res.json({
    success: true,
    data: { menuItemsLocked, prepRecipesLocked, totalLocked },
  });
};

// PUT /api/menu/recipe-lock/all/unlock   { currentPassword }
// Owner only. Removes the locked flag from every menu-item and prep recipe but
// keeps the tenant-wide master password enabled for recipes locked later.
export const unlockAllRecipes = async (req, res) => {
  const { currentPassword } = req.body || {};
  const cfg = await RecipeLockConfig.findOne();
  if (!cfg?.passwordHash) {
    return res.status(400).json({ success: false, message: 'Recipe lock is not enabled.' });
  }
  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Current recipe password is required.',
    });
  }

  const currentMatches = await bcrypt.compare(currentPassword.trim(), cfg.passwordHash);
  if (!currentMatches) {
    await AuditLog.create({
      user: req.user.id,
      action: 'all_recipes_unlock_failed',
      module: 'menu',
      recordId: cfg._id,
      ip: req.ip,
    }).catch(() => {});
    return res.status(400).json({
      success: false,
      message: 'Current recipe password is incorrect.',
    });
  }

  const [mi, pr] = await Promise.all([
    MenuItem.updateMany({ recipeLocked: true }, { $set: { recipeLocked: false } }),
    PrepRecipe.updateMany({ locked: true }, { $set: { locked: false } }),
  ]);
  const menuItemsUnlocked = mi.modifiedCount ?? 0;
  const prepRecipesUnlocked = pr.modifiedCount ?? 0;
  const totalUnlocked = menuItemsUnlocked + prepRecipesUnlocked;

  await AuditLog.create({
    user: req.user.id,
    action: 'all_recipes_unlocked',
    module: 'menu',
    recordId: cfg._id,
    after: { menuItemsUnlocked, prepRecipesUnlocked, totalUnlocked },
    ip: req.ip,
  }).catch(() => {});

  logger.info(
    `All recipes unlocked by ${req.user.email} (${menuItemsUnlocked} menu items, ${prepRecipesUnlocked} preps)`,
  );
  return res.json({
    success: true,
    data: { menuItemsUnlocked, prepRecipesUnlocked, totalUnlocked },
  });
};

// POST /api/menu/recipe-lock/verify   { password }
// Verifies the password server-side and, on success, returns a short-lived
// unlock token. The recipe content is NEVER returned here — the token must then
// be presented on the actual content fetch. Wrong password ⇒ 401, no token.
export const verifyPassword = async (req, res) => {
  const { password } = req.body;
  const cfg = await RecipeLockConfig.findOne().lean();
  if (!cfg?.passwordHash) {
    return res.status(400).json({ success: false, message: 'Recipe lock is not enabled.' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: 'Password is required.' });
  }

  const ok = await bcrypt.compare(password, cfg.passwordHash);
  if (!ok) {
    await AuditLog.create({
      user: req.user.id,
      action: 'recipe_lock_unlock_failed',
      module: 'menu',
      ip: req.ip,
    }).catch(() => {});
    logger.info(`Recipe-lock unlock FAILED by ${req.user.email}`);
    return res.status(401).json({ success: false, message: 'Incorrect password.' });
  }

  const token = signUnlockToken(req);
  logger.info(`Recipe-lock unlocked by ${req.user.email}`);
  return res.json({ success: true, data: { token } });
};
