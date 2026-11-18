import Joi from 'joi';

const objectId = Joi.string()
  .pattern(/^[a-f\d]{24}$/i)
  .messages({ 'string.pattern.base': '{{#label}} must be a valid MongoDB ObjectId.' });

const dealSelectionsInput = Joi.array().items(
  Joi.object({
    groupId: objectId.required(),
    // Repeating an option means choosing more than one of it (for example,
    // two Pepsi selections in a group that allows two drinks).
    optionIds: Joi.array().items(objectId).max(50).default([]),
  })
).unique('groupId').max(20).default([]);

const heldItemCancellationReasonsInput = Joi.object()
  .pattern(
    Joi.string().trim().max(1000),
    Joi.string().trim().min(3).max(300),
  )
  .max(100)
  .optional();

const heldItemCancellationDetailsInput = Joi.object().pattern(
  Joi.string().trim().max(1000),
  Joi.object({
    reason: Joi.string().trim().min(3).max(300).required(),
    prepared: Joi.boolean().strict().required(),
  }),
).max(100).optional();

// ─── Sale payload ──────────────────────────────────────────────────────────────

export const saleSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        menuItemId: objectId.required().messages({ 'any.required': 'menuItemId is required for each item.' }),
        // Chosen size, when the item has variations. Whitelisted so stripUnknown
        // doesn't drop it before the controller resolves the variation price/recipe.
        variationId: objectId.optional(),
        dealSelections: dealSelectionsInput,
        qty: Joi.number().integer().min(1).required().messages({ 'any.required': 'qty is required.' }),
        discountAmount: Joi.number().min(0).default(0),
      })
    )
    .min(1)
    .required()
    .messages({ 'any.required': 'items array is required and must not be empty.' }),

  paymentMethod: Joi.string()
    .valid('cash', 'card', 'online-transfer', 'split-bill', 'allowance', 'charge-to-salary', 'foodpanda')
    .required()
    .messages({ 'any.required': 'paymentMethod is required.' }),

  // Required when paymentMethod is cash
  cashTendered: Joi.when('paymentMethod', {
    is: 'cash',
    then: Joi.number().min(0).required().messages({ 'any.required': 'cashTendered is required for cash payments.' }),
    otherwise: Joi.number().min(0).optional(),
  }),

  // Aggregated card amount — recomputed by the backend for split-bill, but
  // accepted here for forward-compat / external integrations.
  cardAmount: Joi.number().min(0).optional(),

  onlineTransferAmount: Joi.number().min(0).optional(),
  onlineTransferReference: Joi.string().trim().max(100).optional().allow('', null),

  // Food Panda amount / reference — recomputed by the backend, but accepted
  // here so the POS can send them through without validation errors.
  foodPandaAmount: Joi.number().min(0).optional(),
  foodPandaReference: Joi.string().trim().max(100).optional().allow('', null),

  // Split-the-bill payload: required when paymentMethod is 'split-bill'.
  splitBill: Joi.when('paymentMethod', {
    is: 'split-bill',
    then: Joi.object({
      ways: Joi.number().integer().min(2).required(),
      parts: Joi.array()
        .items(
          Joi.object({
            share: Joi.number().min(0).required(),
            method: Joi.string().valid('cash', 'card', 'covered').required(),
            tendered: Joi.number().min(0).optional(),
            change: Joi.number().min(0).optional(),
            cardReference: Joi.string().trim().max(50).optional().allow(''),
            coveredBy: Joi.number().integer().min(0).optional().allow(null),
            note: Joi.string().trim().max(200).optional().allow(''),
            paidAt: Joi.date().optional(),
          }),
        )
        .min(2)
        .required(),
    }).required().messages({ 'any.required': 'splitBill payload is required for split-bill payments.' }),
    otherwise: Joi.any().strip(),
  }),

  // Required when paymentMethod is allowance
  allowanceUserId: Joi.when('paymentMethod', {
    is: 'allowance',
    then: Joi.string().pattern(/^[a-f\d]{24}$/i).required().messages({
      'any.required': 'allowanceUserId is required for allowance payments.',
      'string.pattern.base': 'allowanceUserId must be a valid MongoDB ObjectId.',
    }),
    otherwise: Joi.string().pattern(/^[a-f\d]{24}$/i).optional().allow('', null),
  }),
  // Subject kind for allowance payments — the allowanceUserId is an Employee id
  // when 'employee', or an owner User id when 'user'. Must be whitelisted here
  // or stripUnknown drops it before it reaches the controller.
  allowanceSubjectType: Joi.string().valid('employee', 'user').optional().allow('', null),

  // Required when the order is charged to an employee's salary.
  chargeToSalaryEmployeeId: Joi.when('paymentMethod', {
    is: 'charge-to-salary',
    then: objectId.required().messages({
      'any.required': 'chargeToSalaryEmployeeId is required for charge-to-salary payments.',
    }),
    otherwise: objectId.optional().allow('', null),
  }),
  creditLimitOverride: Joi.when('paymentMethod', {
    is: 'charge-to-salary',
    then: Joi.object({
      requested: Joi.boolean().required(),
      reason: Joi.string().trim().min(5).max(300).when('requested', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional().allow(''),
      }),
    }).optional(),
    otherwise: Joi.any().strip(),
  }),

  // Order-level discount (in addition to any per-item discounts)
  discountAmount: Joi.number().min(0).default(0),

  // Order-level delivery charge (delivery orders) — added on top of the bill.
  deliveryChargeAmount: Joi.number().min(0).default(0),

  // Client-generated UUID for offline deduplication — omit for online sales
  clientTransactionId: Joi.string().trim().max(100).optional().allow(''),

  notes: Joi.string().trim().max(500).optional().allow(''),
  cashierNotes: Joi.string().trim().max(500).optional().allow(''),

  // Client-computed total. Offline sync compares it with the authoritative
  // server total so a stale terminal cannot silently book a different amount.
  totalAmount: Joi.number().min(0).optional(),

  // Extra fields sent by POS frontend (ignored by backend but must pass validation)
  subtotal: Joi.number().min(0).optional(),
  taxAmount: Joi.number().min(0).optional(),
  outletCode: Joi.string().optional().allow(''),
  sessionId: objectId.optional().allow('', null),
  cashierId: objectId.optional().allow('', null),
  queuedAt: Joi.date().iso().optional(),
  offlineAmountAdjustment: Joi.object({
    originalTotal: Joi.number().min(0).required(),
    correctedTotal: Joi.number().min(0).required(),
    shortfall: Joi.number().min(0).required(),
    confirmedAt: Joi.date().iso().required(),
  }).optional(),
  // Local-only dependency marker. The server does not use it, but retaining it
  // through validation lets the sync controller return useful diagnostics.
  localHoldClientTransactionId: Joi.string().trim().max(100).optional().allow('', null),
  note: Joi.string().trim().max(500).optional().allow(''),

  // Order context (customer / delivery)
  orderType: Joi.string().valid('dine-in', 'takeaway', 'delivery', 'foodpanda').default('dine-in'),
  foodPandaOrderNumber: Joi.when('orderType', {
    is: 'foodpanda',
    then: Joi.string().trim().min(1).max(100).required().messages({
      'any.required': 'Foodpanda order number is required.',
      'string.empty': 'Foodpanda order number is required.',
    }),
    otherwise: Joi.string().trim().max(100).optional().allow('', null),
  }),
  foodPandaCustomerName: Joi.string().trim().max(150).optional().allow('', null),
  customerId: objectId.optional().allow('', null),
  tableNumber: Joi.string().trim().max(20).optional().allow(''),
  deliveryAddress: Joi.object({
    label: Joi.string().trim().max(100).optional().allow(''),
    street: Joi.string().trim().max(300).optional().allow(''),
    area: Joi.string().trim().max(200).optional().allow(''),
    city: Joi.string().trim().max(100).optional().allow(''),
  }).optional().allow(null),

  // Discount meta (stored for reference; backend recomputes amount)
  discountMode: Joi.string().valid('amount', 'percent').optional(),
  discountPercent: Joi.number().min(0).max(100).optional(),

  // Payment extras (not used server-side but sent by frontend)
  changeGiven: Joi.number().min(0).optional(),
  cardReference: Joi.string().trim().max(100).optional().allow(''),
  // Last 4 digits of the card — persisted on the sale and shown on receipts /
  // session history. Must survive validation (stripUnknown) to reach the DB.
  cardLast4: Joi.string().trim().pattern(/^\d{4}$/).optional().allow('', null),

  // ID of a held SaleTransaction this sale was resumed from. When present,
  // the backend deletes that held record on successful payment.
  resumedFromHoldId: objectId.optional().allow('', null),
  // Reasons are keyed by the same item/variation/deal signature used by the
  // persisted kitchen quantity baseline. The controller independently derives
  // which quantities were actually cancelled.
  heldItemCancellationReasons: heldItemCancellationReasonsInput,
  heldItemCancellationDetails: heldItemCancellationDetailsInput,
  kdsItemCancellationVersion: Joi.number().integer().min(0).optional(),

  // Membership / Rewards: points the customer wants to redeem on this sale.
  // Validated and applied only when the membershipRewards feature is enabled
  // and a customerId is attached.
  redeemPoints: Joi.number().integer().min(0).optional(),
});

// ─── Hold order payload (same shape as sale, no payment fields required) ──────

export const holdSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        menuItemId: objectId.required(),
        variationId: objectId.optional(),
        dealSelections: dealSelectionsInput,
        qty: Joi.number().integer().min(1).required(),
        discountAmount: Joi.number().min(0).default(0),
      })
    )
    .min(1)
    .required(),
  discountAmount: Joi.number().min(0).default(0),
  discountMode: Joi.string().valid('amount', 'percent').default('amount'),
  discountPercent: Joi.number().min(0).max(100).default(0),
  deliveryChargeAmount: Joi.number().min(0).default(0),
  notes: Joi.string().trim().max(500).optional().allow(''),
  cashierNotes: Joi.string().trim().max(500).optional().allow(''),
  clientTransactionId: Joi.string().trim().max(100).optional().allow(''),
  outletCode: Joi.string().optional().allow(''),
  sessionId: objectId.optional().allow('', null),
  cashierId: objectId.optional().allow('', null),
  queuedAt: Joi.date().iso().optional(),
  // Offline-held orders can be printed before connectivity returns. Preserve
  // their confirmed per-line baseline when they later sync; the controller
  // clamps every key and quantity against the resolved authoritative items.
  kitchenPrintedAt: Joi.date().iso().optional().allow(null),
  kitchenPrintedQtyMap: Joi.object()
    .pattern(Joi.string().trim().max(1000), Joi.number().integer().min(0))
    .optional(),
  heldItemCancellationReasons: heldItemCancellationReasonsInput,
  heldItemCancellationDetails: heldItemCancellationDetailsInput,
  kdsItemCancellationVersion: Joi.number().integer().min(0).optional(),

  // Order context (customer / delivery)
  orderType: Joi.string().valid('dine-in', 'takeaway', 'delivery', 'foodpanda').default('dine-in'),
  foodPandaOrderNumber: Joi.when('orderType', {
    is: 'foodpanda',
    then: Joi.string().trim().min(1).max(100).required().messages({
      'any.required': 'Foodpanda order number is required.',
      'string.empty': 'Foodpanda order number is required.',
    }),
    otherwise: Joi.string().trim().max(100).optional().allow('', null),
  }),
  foodPandaCustomerName: Joi.string().trim().max(150).optional().allow('', null),
  customerId: objectId.optional().allow('', null),
  tableNumber: Joi.string().trim().max(20).optional().allow(''),
  deliveryAddress: Joi.object({
    label: Joi.string().trim().max(100).optional().allow(''),
    street: Joi.string().trim().max(300).optional().allow(''),
    area: Joi.string().trim().max(200).optional().allow(''),
    city: Joi.string().trim().max(100).optional().allow(''),
  }).optional().allow(null),

  // Membership / Rewards: points the cashier intends to redeem when this
  // held order is later resumed and paid. Stored on the held SaleTransaction
  // so resume restores the same redemption selection.
  redeemPoints: Joi.number().integer().min(0).optional(),
});

// ─── Void / Refund payload ────────────────────────────────────────────────────

export const voidSchema = Joi.object({
  voidReason: Joi.string().trim().min(3).max(300).required().messages({
    'any.required': 'voidReason is required.',
    'string.min': 'voidReason must be at least 3 characters.',
  }),
  prepared: Joi.boolean().strict().required(),
  selection: Joi.array().items(
    Joi.object({
      index: Joi.number().integer().min(0).required(),
      qty: Joi.number().integer().min(1).required(),
    }),
  ).min(1).optional().allow(null),
  valuationMethod: Joi.string().valid('ingredientCost', 'orderValue').optional(),
});

export const cancelHeldOrderSchema = Joi.object({
  prepared: Joi.boolean().required().messages({
    'any.required': 'prepared is required.',
  }),
  voidReason: Joi.string().trim().min(3).max(300).required().messages({
    'any.required': 'voidReason is required.',
    'string.empty': 'voidReason is required.',
    'string.min': 'voidReason must be at least 3 characters.',
  }),
  selection: Joi.array().items(
    Joi.object({
      index: Joi.number().integer().min(0).required(),
      qty: Joi.number().integer().min(1).required(),
    }),
  ).min(1).optional().allow(null),
  valuationMethod: Joi.string().valid('ingredientCost', 'orderValue').optional(),
});

export const wasteOrderSchema = Joi.object({
  reason: Joi.string()
    .valid('spoilage', 'spillage', 'overProduction', 'theft', 'expired', 'orderVoid', 'other')
    .optional(),
  notes: Joi.string().trim().min(3).max(300).required().messages({
    'any.required': 'Waste reason is required.',
    'string.empty': 'Waste reason is required.',
    'string.min': 'Waste reason must be at least 3 characters.',
  }),
  rePrepare: Joi.boolean().optional(),
  selection: Joi.array().items(
    Joi.object({
      index: Joi.number().integer().min(0).required(),
      qty: Joi.number().integer().min(1).required(),
    }),
  ).min(1).optional().allow(null),
  valuationMethod: Joi.string().valid('ingredientCost', 'orderValue').optional(),
});

export const refundSchema = Joi.object({
  refundReason: Joi.string().trim().min(3).max(300).required().messages({
    'any.required': 'refundReason is required.',
    'string.min': 'refundReason must be at least 3 characters.',
  }),
});

// ─── Move held-order item payload ─────────────────────────────────────────────
// Moves `qty` units of one menu item from the held order in the URL (:sourceId)
// to another held order (targetHoldId).

export const moveHeldItemSchema = Joi.object({
  targetHoldId: objectId.required().messages({ 'any.required': 'targetHoldId is required.' }),
  menuItemId:   objectId.required().messages({ 'any.required': 'menuItemId is required.' }),
  // Identifies WHICH size line to move when the item has sizes (null = no size).
  variationId:  objectId.optional().allow(null),
  dealSelections: dealSelectionsInput,
  qty:          Joi.number().integer().min(1).required().messages({ 'any.required': 'qty is required.' }),
});

// ─── Offline sync payload ─────────────────────────────────────────────────────

export const syncOfflineSchema = Joi.object({
  transactions: Joi.array()
    // Individual sales are validated inside syncOffline so one malformed local
    // record cannot reject the entire batch before the controller can report
    // which item needs attention.
    .items(Joi.object().unknown(true))
    .min(1)
    .required()
    .messages({ 'any.required': 'transactions array is required.' }),
});

export const offlineSyncStatusSchema = Joi.object({
  clientTransactionIds: Joi.array()
    .items(Joi.string().trim().min(1).max(100))
    .min(1)
    .max(250)
    .required(),
});

// ─── validate middleware ───────────────────────────────────────────────────────

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
