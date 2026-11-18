import jwt from 'jsonwebtoken';
import { PlatformAdminModel } from '../models/PlatformAdmin.js';

const requirePlatformAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }

  if (!decoded.isPlatformAdmin) {
    return res.status(403).json({ success: false, message: 'Platform admin access required.' });
  }

  const admin = await PlatformAdminModel().findById(decoded.id);
  if (!admin || !admin.isActive) {
    return res.status(401).json({ success: false, message: 'Admin account is inactive.' });
  }
  req.admin = { id: admin._id, name: admin.name, email: admin.email };
  next();
};

export default requirePlatformAdmin;
