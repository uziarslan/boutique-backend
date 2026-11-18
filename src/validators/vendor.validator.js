import Joi from 'joi';

const addressSchema = Joi.object({
  street:  Joi.string().trim().max(200).optional().allow(''),
  city:    Joi.string().trim().max(100).optional().allow(''),
  country: Joi.string().trim().max(100).optional().allow(''),
});

// Fields shared between create and update
const vendorFields = {
  name: Joi.string().trim().min(2).max(200),
  category: Joi.string().trim().max(100).allow(''),
  address: addressSchema,
  contactName: Joi.string().trim().max(150).allow(''),
  phone: Joi.string().trim().max(30).allow(''),
  email: Joi.string().email().lowercase().trim().allow(''),
  paymentTerms: Joi.number().integer().min(0).max(365),
  creditLimit: Joi.number().min(0),
  currency: Joi.string().trim().uppercase().length(3),
  status: Joi.string().valid('active', 'inactive', 'onHold'),
  notes: Joi.string().trim().max(2000).allow(''),
};

export const createVendorSchema = Joi.object({
  ...vendorFields,
  name: vendorFields.name.required().messages({
    'any.required': 'Vendor name is required.',
    'string.min': 'Vendor name must be at least 2 characters.',
  }),
});

// All fields optional for PATCH semantics
export const updateVendorSchema = Joi.object(vendorFields).min(1).messages({
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
