import Joi from 'joi';

export const recordPaymentSchema = Joi.object({
  invoiceId: Joi.string()
    .pattern(/^[a-f\d]{24}$/i)
    .required()
    .label('invoiceId')
    .messages({ 'string.pattern.base': 'invoiceId must be a valid ObjectId.' }),

  amount: Joi.number()
    .positive()
    .required()
    .messages({
      'number.positive': 'Payment amount must be greater than 0.',
      'any.required':    'Amount is required.',
    }),

  method: Joi.string()
    .valid('bankTransfer', 'cash', 'cheque', 'creditCard')
    .required()
    .messages({
      'any.only':     'Method must be one of: bankTransfer, cash, cheque, creditCard.',
      'any.required': 'Payment method is required.',
    }),

  reference:   Joi.string().trim().max(200).allow(''),
  paymentDate: Joi.date().iso().max('now').messages({
    'date.max': 'Payment date cannot be in the future.',
  }),
  currency: Joi.string().trim().uppercase().length(3),
  notes:    Joi.string().trim().max(2000).allow(''),
});

export const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly:    false,
    stripUnknown:  true,
  });

  if (error) {
    const message = error.details.map((d) => d.message).join('. ');
    return res.status(422).json({ success: false, message });
  }

  req.body = value;
  next();
};
