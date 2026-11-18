import Joi from 'joi';

const objectId = Joi.string()
  .pattern(/^[a-f\d]{24}$/i)
  .messages({ 'string.pattern.base': '{{#label}} must be a valid MongoDB ObjectId.' });

// ─── Category schemas ──────────────────────────────────────────────────────────

export const createCategorySchema = Joi.object({
  name:      Joi.string().trim().min(1).max(100).required().messages({ 'any.required': 'Category name is required.' }),
  outlet:    objectId.required().messages({ 'any.required': 'Outlet id is required.' }),
  sortOrder: Joi.number().integer().min(0).default(0),
  color:     Joi.string().trim().max(20).default('#4F46E5'),
  isActive:  Joi.boolean().default(true),
});

export const updateCategorySchema = Joi.object({
  name:      Joi.string().trim().min(1).max(100),
  sortOrder: Joi.number().integer().min(0),
  color:     Joi.string().trim().max(20),
  isActive:  Joi.boolean(),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update.' });

// ─── Menu item schemas ─────────────────────────────────────────────────────────

// A size variation carries only name + price (+ ordering). The per-variation
// recipe is authored separately through the recipe route, keyed by variation id.
const variationInput = Joi.object({
  _id:       objectId.optional(),
  name:      Joi.string().trim().min(1).max(60).required().messages({ 'any.required': 'Each variation needs a name.' }),
  price:     Joi.number().min(0).required().messages({ 'any.required': 'Each variation needs a price.' }),
  foodPandaPrice: Joi.number().min(0).optional().allow(null),
  sortOrder: Joi.number().integer().min(0).default(0),
});

const dealComponentInput = Joi.object({
  _id:        objectId.optional(),
  menuItem:   objectId.required().messages({ 'any.required': 'Each deal component needs a menu item.' }),
  variationId: objectId.optional().allow(null),
  qty:        Joi.number().integer().min(1).default(1),
  sortOrder:  Joi.number().integer().min(0).default(0),
});

const dealOptionInput = dealComponentInput.keys({
  priceAdjustment: Joi.number().min(0).default(0),
});

const dealChoiceGroupInput = Joi.object({
  _id:           objectId.optional(),
  name:          Joi.string().trim().min(1).max(100).required(),
  minSelections: Joi.number().integer().min(0).max(50).default(1),
  maxSelections: Joi.number().integer().min(1).max(50).default(1),
  sortOrder:     Joi.number().integer().min(0).default(0),
  options:       Joi.array().items(dealOptionInput).min(1).max(50).required(),
});

const dealConfigInput = Joi.object({
  fixedItems:   Joi.array().items(dealComponentInput).max(100).default([]),
  choiceGroups: Joi.array().items(dealChoiceGroupInput).max(20).default([]),
});

const praInput = Joi.object({
  itemCode: Joi.string().trim().max(50).allow('').optional(),
  // Formatting separators are accepted for data entry; the controller stores
  // the normalized eight-digit value required by PRA.
  pctCode: Joi.string().trim().max(20).pattern(/^(?:\d[.\s-]*){8}$/).allow('').optional(),
});

export const createMenuItemSchema = Joi.object({
  name:           Joi.string().trim().min(1).max(150).required().messages({ 'any.required': 'Item name is required.' }),
  outlet:         objectId.required().messages({ 'any.required': 'Outlet id is required.' }),
  category:       objectId.required().messages({ 'any.required': 'Category id is required.' }),
  itemType:       Joi.string().valid('regular', 'deal').default('regular'),
  dealConfig:     dealConfigInput.optional(),
  // Base price is required only for a single-price item; with variations the
  // price comes from each variation instead.
  price:          Joi.number().min(0).when('variations', {
    is:        Joi.array().min(1).required(),
    then:      Joi.number().min(0).optional(),
    otherwise: Joi.number().min(0).required().messages({ 'any.required': 'Price is required.' }),
  }),
  foodPandaPrice: Joi.number().min(0).optional().allow(null),
  priceMode:      Joi.string().valid('exclusive', 'inclusive').default('exclusive'),
  variations:     Joi.array().items(variationInput).max(20).optional(),
  taxRate:        Joi.number().min(0).max(100).default(0),
  serviceCharge:  Joi.number().min(0).max(100).default(0),
  description:    Joi.string().trim().max(500).optional().allow(''),
  imageUrl:       Joi.string().trim().uri().max(500).optional().allow(''),
  isAvailable:    Joi.boolean().default(true),
  isAvailableForQrOrder: Joi.boolean().default(true),
  sortOrder:      Joi.number().integer().min(0).default(0),
  pra:            praInput.optional(),
});

export const updateMenuItemSchema = Joi.object({
  name:           Joi.string().trim().min(1).max(150),
  category:       objectId,
  itemType:       Joi.string().valid('regular', 'deal'),
  dealConfig:     dealConfigInput,
  price:          Joi.number().min(0),
  foodPandaPrice: Joi.number().min(0).allow(null),
  priceMode:      Joi.string().valid('exclusive', 'inclusive'),
  variations:     Joi.array().items(variationInput).max(20),
  taxRate:        Joi.number().min(0).max(100),
  serviceCharge:  Joi.number().min(0).max(100),
  description:    Joi.string().trim().max(500).allow('', null),
  imageUrl:       Joi.string().trim().uri().max(500).allow('', null),
  isAvailable:    Joi.boolean(),
  isAvailableForQrOrder: Joi.boolean(),
  sortOrder:      Joi.number().integer().min(0),
  pra:            praInput,
}).min(1).messages({ 'object.min': 'At least one field must be provided for update.' });

// Recipe save (PUT /api/menu/items/:itemId/recipe). When variationId is present
// the ingredients belong to that variation's recipe; otherwise the item recipe.
export const saveRecipeSchema = Joi.object({
  variationId:    objectId.optional(),
  trackInventory: Joi.boolean().optional(),
  ingredients:    Joi.array().items(
    Joi.object({
      _id:              objectId.optional(),
      product:          objectId.required().messages({ 'any.required': 'Each ingredient needs a product.' }),
      qty:              Joi.number().greater(0).required().messages({ 'any.required': 'Each ingredient needs a quantity.' }),
      unit:             Joi.string().trim().min(1).max(50).required().messages({ 'any.required': 'Each ingredient needs a unit.' }),
      parLevel:         Joi.number().min(0).default(0),
      varianceBaseline: Joi.number().min(0).max(50).default(5),
      notes:            Joi.string().trim().max(500).allow('').optional(),
    })
  ).default([]),
});

// ─── Ingredient (catalog product) quick-create ─────────────────────────────────
// Lets the Recipe Editor register a new ingredient that has no inventory yet.
// Only the essentials — it can be priced/stocked later via the PO → GRN flow.

export const createIngredientSchema = Joi.object({
  name:         Joi.string().trim().min(2).max(200).required().messages({ 'any.required': 'Ingredient name is required.' }),
  unit:         Joi.string().trim().min(1).max(50).required().messages({ 'any.required': 'Unit is required.' }),
  category:     Joi.string().trim().max(100).optional().allow(''),
  defaultPrice: Joi.number().min(0).optional(),
});

// ─── Prep recipe schemas ───────────────────────────────────────────────────────
// A reusable in-house preparation (marination, sauce…) built from raw products
// and/or other preps, then produced into stock in batches.

const prepIngredientItem = Joi.object({
  product: objectId.required().messages({ 'any.required': 'Each ingredient needs a product.' }),
  qty:     Joi.number().greater(0).required().messages({ 'any.required': 'Each ingredient needs a quantity.' }),
  unit:    Joi.string().trim().min(1).max(50).required().messages({ 'any.required': 'Each ingredient needs a unit.' }),
});

export const createPrepRecipeSchema = Joi.object({
  name:        Joi.string().trim().min(2).max(150).required().messages({ 'any.required': 'Prep recipe name is required.' }),
  category:    Joi.string().trim().max(100).optional().allow(''),
  yieldQty:    Joi.number().greater(0).required().messages({ 'any.required': 'Batch yield is required.' }),
  yieldUnit:   Joi.string().trim().min(1).max(50).required().messages({ 'any.required': 'Yield unit is required.' }),
  ingredients: Joi.array().items(prepIngredientItem).min(1).required().messages({ 'array.min': 'Add at least one ingredient.' }),
});

export const updatePrepRecipeSchema = Joi.object({
  name:        Joi.string().trim().min(2).max(150),
  category:    Joi.string().trim().max(100).allow(''),
  yieldQty:    Joi.number().greater(0),
  yieldUnit:   Joi.string().trim().min(1).max(50),
  ingredients: Joi.array().items(prepIngredientItem).min(1),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update.' });

export const producePrepBatchSchema = Joi.object({
  batches: Joi.number().greater(0).required().messages({ 'any.required': 'Number of batches is required.' }),
  outlet:  objectId.optional(),
});

export const bulkAvailabilitySchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        id:          objectId.required(),
        isAvailable: Joi.boolean().required(),
      })
    )
    .min(1)
    .required()
    .messages({ 'any.required': 'items array is required.' }),
});

// ─── validate middleware ───────────────────────────────────────────────────────

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
