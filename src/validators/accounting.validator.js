import Joi from 'joi';

const objectId = Joi.string().pattern(/^[a-f\d]{24}$/i).messages({
  'string.pattern.base': '{{#label}} must be a valid ObjectId.',
});

// ─── ChartOfAccounts ──────────────────────────────────────────────────────────

export const createAccountSchema = Joi.object({
  code: Joi.string().trim().max(20).required().messages({
    'any.required': 'Account code is required.',
  }),
  name: Joi.string().trim().min(2).max(200).required().messages({
    'any.required': 'Account name is required.',
  }),
  type: Joi.string()
    .valid('asset', 'liability', 'equity', 'revenue', 'expense')
    .required(),
  normalBalance: Joi.string().valid('debit', 'credit').required(),
  subType:       Joi.string().trim().max(100).allow(''),
  description:   Joi.string().trim().max(1000).allow(''),
  parentAccount: objectId.allow(null).label('parentAccount'),
  isActive:      Joi.boolean().default(true),
});

// System account fields (code/type/normalBalance) cannot be changed
export const updateAccountSchema = Joi.object({
  name:          Joi.string().trim().min(2).max(200),
  subType:       Joi.string().trim().max(100).allow(''),
  description:   Joi.string().trim().max(1000).allow(''),
  isActive:      Joi.boolean(),
  parentAccount: objectId.allow(null).label('parentAccount'),
}).min(1).messages({ 'object.min': 'At least one field must be provided.' });

// ─── Manual Journal Entry ─────────────────────────────────────────────────────

const jeLineSchema = Joi.object({
  account: objectId.required().label('account'),
  debit:   Joi.number().min(0).default(0),
  credit:  Joi.number().min(0).default(0),
  notes:   Joi.string().trim().max(500).allow(''),
});

export const createJournalEntrySchema = Joi.object({
  date:        Joi.date().iso().required(),
  description: Joi.string().trim().min(3).max(500).required(),
  party:       Joi.string().trim().max(120).allow('', null),
  partyVendor: Joi.string().hex().length(24).allow('', null),
  lines:       Joi.array().items(jeLineSchema).min(2).required().messages({
    'array.min': 'A journal entry requires at least two lines.',
  }),
});

// The service applies stricter source-aware rules to invoice/payment entries;
// other modules can use the complete edit shape.
export const updateJournalEntrySchema = Joi.object({
  date:        Joi.date().iso().required(),
  description: Joi.string().trim().min(3).max(500).required(),
  party:       Joi.string().trim().max(120).allow('', null),
  partyVendor: Joi.string().hex().length(24).allow('', null),
  lines:       Joi.array().items(jeLineSchema).min(2).required().messages({
    'array.min': 'A journal entry requires at least two lines.',
  }),
});

// ─── Validate middleware ──────────────────────────────────────────────────────

export const orderSalaryChargeSchema = Joi.object({
  employeeId: objectId.required(),
  reason: Joi.string().trim().min(5).max(500).required(),
  creditLimitOverride: Joi.object({
    requested: Joi.boolean().default(false),
    reason: Joi.string().trim().max(500).allow(''),
  }),
});

export const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly:   false,
    stripUnknown: true,
  });

  if (error) {
    const message = error.details.map((d) => d.message).join('. ');
    return res.status(422).json({ success: false, message });
  }

  req.body = value;
  next();
};
