import { Router } from 'express';
import {
  signup,
  register,
  login,
  posLogin,
  riderLogin,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  me,
} from '../controllers/auth.controller.js';
import protect from '../middleware/auth.middleware.js';
import requireActiveSubscription from '../middleware/subscription.middleware.js';
import { env } from '../config/env.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import {
  validate,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  signupSchema,
} from '../validators/auth.validator.js';

const router = Router();

const authLimiter = createRateLimiter({
  prefix: 'auth-entry',
  windowMs: 15 * 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  message: 'Too many login or signup attempts. Please try again later.',
});

const recoveryLimiter = createRateLimiter({
  prefix: 'auth-recovery',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many password recovery attempts. Please wait and try again.',
});

const refreshLimiter = createRateLimiter({
  prefix: 'auth-refresh',
  windowMs: 60 * 1000,
  max: 90,
  message: 'Too many token refresh attempts. Please wait and try again.',
});

// Fully public — no auth, no tenant context.
router.post('/signup', authLimiter, validate(signupSchema), signup);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/pos-login', authLimiter, validate(loginSchema), posLogin);
router.post('/rider-login', authLimiter, validate(loginSchema), riderLogin);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);
router.post('/forgot-password', recoveryLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', recoveryLimiter, validate(resetPasswordSchema), resetPassword);

// Authenticated — adding a team member to the current tenant
router.post('/register', protect, requireActiveSubscription, validate(registerSchema), register);

router.get('/me', protect, me);

export default router;
