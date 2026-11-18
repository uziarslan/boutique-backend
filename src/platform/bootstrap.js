import { PlatformAdminModel } from './models/PlatformAdmin.js';
import logger from '../utils/logger.js';

// Seeds the first platform super-admin from PLATFORM_ADMIN_EMAIL +
// PLATFORM_ADMIN_PASSWORD on startup if one doesn't exist yet. Lets the
// operator log into the admin frontend on a fresh install.
const seedPlatformAdmin = async () => {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME || 'Super Admin';
  if (!email || !password) return;

  const Admin = PlatformAdminModel();
  const existing = await Admin.findOne({ email: email.toLowerCase() });
  if (existing) return;

  await Admin.create({ email, password, name, isActive: true });
  logger.info(`Seeded initial platform admin: ${email}`);
};

export default seedPlatformAdmin;
