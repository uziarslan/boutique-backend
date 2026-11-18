import jwt from 'jsonwebtoken';
import { PlatformAdminModel } from '../models/PlatformAdmin.js';
import logger from '../../utils/logger.js';

const REFRESH_COOKIE = 'adminRefreshToken';

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

const sendAdminTokens = async (admin, statusCode, res) => {
  const accessToken = admin.generateAccessToken();
  const refreshToken = admin.generateRefreshToken();
  admin.refreshToken = refreshToken;
  await admin.save({ validateBeforeSave: false });
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
  return res.status(statusCode).json({
    success: true,
    accessToken,
    admin: { id: admin._id, name: admin.name, email: admin.email },
  });
};

export const adminLogin = async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(422).json({ success: false, message: 'Email and password required.' });
  }
  const admin = await PlatformAdminModel().findOne({ email: String(email).toLowerCase() }).select('+password');
  if (!admin) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  const ok = await admin.comparePassword(password);
  if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  if (!admin.isActive) return res.status(401).json({ success: false, message: 'Admin account is inactive.' });

  logger.info(`Platform admin logged in: ${email}`);
  return sendAdminTokens(admin, 200, res);
};

export const adminRefresh = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ success: false, message: 'No refresh token.' });
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
  if (!decoded.isPlatformAdmin) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
  const admin = await PlatformAdminModel().findById(decoded.id).select('+refreshToken');
  if (!admin || admin.refreshToken !== token) {
    return res.status(401).json({ success: false, message: 'Refresh token reuse detected.' });
  }
  return sendAdminTokens(admin, 200, res);
};

export const adminLogout = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      if (decoded?.id) {
        await PlatformAdminModel().findByIdAndUpdate(decoded.id, { refreshToken: null });
      }
    } catch { /* ignore */ }
  }
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  });
  return res.json({ success: true });
};

export const adminMe = async (req, res) =>
  res.json({ success: true, admin: req.admin });
