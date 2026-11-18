import Joi from 'joi';

const password = Joi.string().min(8).required().messages({
  'string.min': 'Password must be at least 8 characters.',
  'any.required': 'Password is required.',
});

export const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required().messages({
    'any.required': 'Name is required.',
  }),
  email: Joi.string().email().lowercase().trim().required().messages({
    'string.email': 'A valid email address is required.',
    'any.required': 'Email is required.',
  }),
  password,
  role: Joi.string()
    .valid('owner', 'financeManager', 'purchaseManager', 'receivingStaff', 'cashier', 'rider')
    .default('receivingStaff'),
  // outlet is required for operational device users, optional for other roles
  outlet: Joi.when('role', {
    is:        Joi.valid('cashier', 'rider'),
    then:      Joi.string().trim().max(100).required().messages({
      'any.required': 'Outlet is required for cashier and rider accounts.',
      'string.empty': 'Outlet is required for cashier and rider accounts.',
    }),
    otherwise: Joi.string().trim().max(100).optional().allow(''),
  }),
});

export const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().required(),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
});

export const resetPasswordSchema = Joi.object({
  token: Joi.string().required().messages({
    'any.required': 'Reset token is required.',
  }),
  password,
});

export const signupSchema = Joi.object({
  outletName: Joi.string().trim().min(2).max(80).required().messages({
    'any.required': 'Outlet name is required.',
    'string.empty': 'Outlet name is required.',
  }),
  ownerName: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().lowercase().trim().required(),
  password,
});

/**
 * Thin middleware wrapper — validates req.body against a Joi schema.
 * On failure returns 422 with all validation messages joined.
 */
export const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const message = error.details.map((d) => d.message).join('. ');
    return res.status(422).json({ success: false, message });
  }

  req.body = value;
  next();
};
