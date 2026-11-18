import Joi from 'joi';

const objectId = Joi.string()
  .pattern(/^[a-f\d]{24}$/i)
  .messages({ 'string.pattern.base': '{{#label}} must be a valid ObjectId.' });

// Vendor entry inside the vendors array
const vendorEntrySchema = Joi.object({
  vendorId:          objectId.required(),
  vendorProductCode: Joi.string().trim().max(100).allow(''),
  packSize:          Joi.string().trim().max(100).allow(''),
  currentPrice:      Joi.number().min(0),
  lastPrice:         Joi.number().min(0),
  // priceHistory is managed by the controller, not accepted from the client
});

// Vendor entry for updates — vendorId required so we can find the right entry
const vendorUpdateEntry = Joi.object({
  vendorId:          objectId.required(),
  vendorProductCode: Joi.string().trim().max(100).allow(''),
  packSize:          Joi.string().trim().max(100).allow(''),
  currentPrice:      Joi.number().min(0),
});

const sharedFields = {
  category:        Joi.string().trim().max(100),
  unit:            Joi.string().trim().max(50),
  storageLocation: Joi.string().trim().max(200).allow(''),
  shelfLifeDays:   Joi.number().integer().min(0),
  parLevel:        Joi.number().min(0),
  reorderQty:      Joi.number().min(0),
  isActive:        Joi.boolean(),
  notes:           Joi.string().trim().max(2000).allow(''),
};

export const createProductSchema = Joi.object({
  ...sharedFields,
  name: Joi.string().trim().min(2).max(200).required().messages({
    'any.required': 'Product name is required.',
  }),
  category: Joi.string().trim().max(100).required().messages({
    'any.required': 'Category is required.',
  }),
  unit: Joi.string().trim().max(50).required().messages({
    'any.required': 'Unit of measure is required.',
  }),
  vendors: Joi.array().items(vendorEntrySchema).default([]),
});

export const updateProductSchema = Joi.object({
  ...sharedFields,
  name:    Joi.string().trim().min(2).max(200),
  vendors: Joi.array().items(vendorUpdateEntry),
}).min(1).messages({
  'object.min': 'At least one field must be provided for update.',
});

// ─── Reusable validate middleware ─────────────────────────────────────────────

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
