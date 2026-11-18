import { randomUUID } from 'crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const normalizeRequestId = (value) => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
};

const requestContext = (req, res, next) => {
  req.id = normalizeRequestId(req.headers['x-request-id']) || randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
};

export default requestContext;
