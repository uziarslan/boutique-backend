import mongoose from 'mongoose';
import logger from '../utils/logger.js';

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  logger.error(`${err.name}: ${err.message}${err.stack ? '\n' + err.stack : ''}`, {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl || req.url,
    tenantSlug: req.tenantSlug,
  });

  // Mongoose CastError — invalid ObjectId
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      success: false,
      message: `Invalid value for field '${err.path}': ${err.value}`,
    });
  }

  // Mongoose ValidationError
  if (err instanceof mongoose.Error.ValidationError) {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: messages.join('. '),
    });
  }

  // MongoDB duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    const value = err.keyValue?.[field] ?? '';
    return res.status(409).json({
      success: false,
      message: field === 'deviceEmployeeNo'
        ? 'Device Person ID is already assigned to another employee. Choose a unique ID.'
        : `Duplicate value: '${value}' already exists for ${field}.`,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired.' });
  }

  // Generic fallback
  const statusCode = err.statusCode || err.status || 500;
  const response = {
    success: false,
    message: err.message || 'Internal server error.',
  };
  if (err.code) response.code = err.code;
  if (err.summary) response.creditSummary = err.summary;
  if (err.reasons) response.reasons = err.reasons;

  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  return res.status(statusCode).json(response);
};

export default errorHandler;
