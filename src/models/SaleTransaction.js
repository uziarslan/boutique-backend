import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import { getBusinessDate } from '../utils/businessDate.js';
import generateTransactionNumber from '../utils/transactionNumber.js';

// ─── Line-item sub-schema ─────────────────────────────────────────────────────

const dealSelectionSnapshotSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, required: true },
    groupName: { type: String, trim: true },
    optionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { _id: false }
);

const dealComponentSnapshotSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['fixed', 'choice'], required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, default: null },
    groupName: { type: String, trim: true, default: null },
    optionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' },
    categoryName: { type: String, trim: true },
    variation: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: null },
    },
    name: { type: String, required: true, trim: true },
    // Quantity included in one deal. Kitchen and inventory quantities multiply
    // this value by the parent deal line quantity.
    qtyPerDeal: { type: Number, required: true, min: 1 },
    priceAdjustment: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const saleItemSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
    },
    retailVariant: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailVariant', default: null },
    externalItemId: { type: String, trim: true, default: '' },
    skuSnapshot: { type: String, trim: true, default: '' },
    barcodeSnapshot: { type: String, trim: true, default: '' },
    optionsSnapshot: { type: [{ name: String, value: String }], default: [] },
    unitCostSnapshot: { type: Number, min: 0, default: 0 },
    unitCostStatusSnapshot: { type: String, enum: ['complete', 'review'], default: 'review' },
    offlinePriceMismatch: { type: Boolean, default: false },
    // Snapshot used by kitchen-printer routing. The ID keeps assignments stable;
    // the name keeps old tickets understandable after a category is renamed.
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' },
    categoryName: { type: String, trim: true },
    // Chosen size variation, when the item has sizes. `id` points at the
    // MenuItem.variations subdoc; `name` is snapshotted so receipts/reports
    // survive later menu edits. Null/absent for single-price items.
    variation: {
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true },
    },
    // Snapshot of name at sale time — survives menu edits
    name: {
      type: String,
      required: true,
      trim: true,
    },
    qty: {
      type: Number,
      required: true,
      min: [1, 'Qty must be at least 1.'],
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    // Authored menu price + treatment snapshot. `unitPrice`/`lineTotal` remain
    // net of tax and service for accounting, reporting and PRA.
    listedUnitPrice: { type: Number, min: 0 },
    priceMode: {
      type: String,
      enum: ['exclusive', 'inclusive'],
      default: 'exclusive',
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    taxAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    serviceChargeAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    serviceChargeRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Fiscal classification snapshot. PRA credit invoices must reproduce the
    // original sale even if the menu item or outlet default changes later.
    pra: {
      itemCode: { type: String, trim: true, maxlength: 50 },
      pctCode: { type: String, trim: true, maxlength: 8 },
    },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
    dealSelections: { type: [dealSelectionSnapshotSchema], default: [] },
    dealComponents: { type: [dealComponentSnapshotSchema], default: [] },
    // Units of this line already logged as waste. Supports incremental partial
    // waste (e.g. 1 of a "×3" line spoils now, another later). 0..qty.
    wastedQty: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

// ─── SaleTransaction schema ───────────────────────────────────────────────────

const saleTransactionSchema = new mongoose.Schema(
  {
    transactionNumber: {
      type: String,
      unique: true,
      trim: true,
      // auto-generated by pre-save hook
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: [true, 'Outlet is required.'],
    },
    // Immutable operating date assigned from the outlet's local day boundary.
    businessDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    // null for external POS transactions (no session concept).
    // Required for custom POS — enforced in the sale controller, not the schema,
    // so that webhook transactions can be stored in the same collection.
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SaleSession',
      default: null,
    },
    cashier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Optional at the schema level — QR self-orders enter as
      // 'pending-approval' without a cashier and only get one assigned at
      // approval time. Cashier-driven sales enforce required-ness in the
      // sale controller, not the schema.
      default: null,
    },
    items: {
      type: [saleItemSchema],
      default: [],
    },

    kdsItemCancellationVersion: { type: Number, default: 0, min: 0 },

    // ── Computed totals ────────────────────────────────────────────────────────
    subtotal: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    // Effective sales-tax rate (%) actually charged on this sale. Card and
    // online payments may independently receive the reduced rate; split-bill
    // stores the blend of eligible card and standard-rate portions.
    effectiveTaxRate: { type: Number, default: 0, min: 0, max: 100 },
    serviceChargeAmount: { type: Number, default: 0, min: 0 },
    // Order-level delivery charge (added on top of the bill for delivery orders).
    // Posts to the Delivery Charges revenue head; captured at the POS terminal.
    deliveryChargeAmount: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    discountMode: { type: String, enum: ['amount', 'percent'], default: 'amount' },
    discountPercent: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    // ── Payment ────────────────────────────────────────────────────────────────
    paymentMethod: {
      type: String,
      // 'split' is retained for legacy data only — new sales should use
      // 'split-bill' (the per-person split flow) instead.
      enum: ['cash', 'card', 'online-transfer', 'split', 'split-bill', 'store-credit', 'allowance', 'charge-to-salary', 'foodpanda', 'shopify'],
      required: [true, 'Payment method is required.'],
    },
    // Cash portion — equals totalAmount when method=cash; 0 when method=card.
    // The session close aggregation in P2-03 relies on this field.
    cashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Card portion — equals totalAmount when method=card; 0 when method=cash.
    cardAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Bank/mobile-wallet transfer portion. Kept separate from card so shift
    // reconciliation and management reporting can match bank statements.
    onlineTransferAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    onlineTransferReference: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    // Food Panda portion — equals totalAmount when method=foodpanda; 0 otherwise.
    foodPandaAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Optional Food Panda order / invoice reference.
    foodPandaReference: {
      type: String,
      trim: true,
      default: null,
    },
    // Captured as soon as the Foodpanda order type is selected, so held orders
    // and kitchen tickets retain the required order number before checkout.
    foodPandaOrderNumber: {
      type: String,
      trim: true,
      default: null,
    },
    foodPandaCustomerName: {
      type: String,
      trim: true,
      default: null,
    },
    cashTendered: {
      type: Number,
      min: 0,
    },
    changeGiven: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Last 4 digits of the card used (optional, manually entered by the cashier
    // for card / split-bill card payments). Stored for reconciliation and shown
    // on the receipt + management sale detail. Not a legal tax requirement.
    cardLast4: {
      type: String,
      trim: true,
      match: [/\d{4}$/, 'Card last-4 must be exactly 4 digits.'],
      default: null,
    },

    // ── Allowance payment ──────────────────────────────────────────────────────
    // Populated when paymentMethod === 'allowance'. `allowanceUser` holds the
    // subject id (Employee._id or owner User._id — see allowanceSubjectType).
    allowanceUser: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    allowanceSubjectType: {
      type: String,
      enum: ['employee', 'user'],
      default: null,
    },
    allowanceSubjectName: { type: String, trim: true, default: null },

    // ── Charge-to-salary payment ───────────────────────────────────────────────
    // The checkout creates a linked SalaryAdvance(type=cts). Payroll recovers
    // that receivable through the same workflow as advances entered manually.
    chargeToSalaryEmployee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    chargeToSalaryEmployeeName: { type: String, trim: true, default: null },
    // Owner correction metadata for POS-originated CTS records. The live
    // totalAmount may be corrected from payroll, while the first punched
    // amount remains available here for audit and reconciliation.
    ctsCorrection: {
      originalAmount: { type: Number, min: 0 },
      correctedAmount: { type: Number, min: 0 },
      reason: { type: String, trim: true },
      correctedAt: { type: Date },
      correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    salaryAdvance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SalaryAdvance',
      default: null,
    },

    // ── Status ─────────────────────────────────────────────────────────────────
    status: {
      type: String,
      // 'pending-approval' is the entry state for QR self-orders awaiting
      // cashier approval. On approve → 'held'. On decline → 'void'.
      // 'out-for-delivery' is a dispatched-but-UNPAID delivery order: stock is
      // deducted (food is made & handed to the rider) but no payment/JE yet.
      // On collection → 'completed'; if undelivered → 'void'.
      enum: ['completed', 'refunded', 'held', 'void', 'pending-approval', 'out-for-delivery'],
      default: 'completed',
    },
    // Origin of the order. 'cashier' for terminal entries, 'qr-self-order'
    // for orders placed by a customer via the public table-QR flow.
    source: {
      type: String,
      enum: ['cashier', 'qr-self-order', 'staff-tablet', 'shopify'],
      default: 'cashier',
    },
    shopifyOrderId: { type: String, trim: true, default: undefined },
    shopifyOrderName: { type: String, trim: true, default: '' },
    shopifyCurrency: { type: String, uppercase: true, trim: true, default: '' },
    shopifyFinancialStatus: { type: String, trim: true, default: '' },
    storeCreditCode: { type: String, trim: true, uppercase: true, default: '' },
    storeCreditRedeemed: { type: Number, min: 0, default: 0 },
    retailReturnUpdatedAt: { type: Date, default: null },
    retailReturnStatus: { type: String, enum: ['none', 'partial', 'fully-returned'], default: 'none' },
    costOfGoodsSold: { type: Number, min: 0, default: 0 },
    costingStatus: { type: String, enum: ['complete', 'review'], default: 'complete' },
    // Populated only when source === 'qr-self-order'.
    qrOrder: {
      tableCode: { type: String, trim: true },
      tableLabel: { type: String, trim: true },
      customerPhone: { type: String, trim: true },
      customerName: { type: String, trim: true },
      // A repeat submission from an occupied QR table belongs to this same
      // transaction. While the cashier is reviewing it, keep only the new
      // delta here so the original held bill remains payable as one TXN and
      // the kitchen can print only the newly-approved quantities.
      pendingAddOn: {
        items: { type: [saleItemSchema], default: [] },
        notes: { type: String, trim: true, maxlength: 500, default: '' },
        submittedAt: { type: Date },
        submissionCount: { type: Number, min: 1, default: 1 },
        subtotal: { type: Number, min: 0, default: 0 },
        taxAmount: { type: Number, min: 0, default: 0 },
        effectiveTaxRate: { type: Number, min: 0, max: 100, default: 0 },
        serviceChargeAmount: { type: Number, min: 0, default: 0 },
        serviceChargeRate: { type: Number, min: 0, max: 100, default: 0 },
        totalAmount: { type: Number, min: 0, default: 0 },
        combinedSubtotal: { type: Number, min: 0, default: 0 },
        combinedTaxAmount: { type: Number, min: 0, default: 0 },
        combinedEffectiveTaxRate: { type: Number, min: 0, max: 100, default: 0 },
        combinedServiceChargeAmount: { type: Number, min: 0, default: 0 },
        combinedServiceChargeRate: { type: Number, min: 0, max: 100, default: 0 },
        combinedTotalAmount: { type: Number, min: 0, default: 0 },
      },
      addOnCount: { type: Number, min: 0, default: 0 },
      lastAddOnAt: { type: Date },
      approvedAt: { type: Date },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      declinedAt: { type: Date },
      declinedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      declineReason: { type: String, trim: true },
      addOnDeclineReason: { type: String, trim: true },
      // A random customer token is returned once when the order is placed;
      // only its digest is retained so another guest cannot request this bill
      // merely by guessing a transaction number.
      customerAccessTokenHash: { type: String, select: false },
      billRequest: {
        status: {
          type: String,
          enum: ['none', 'pending', 'acknowledged'],
          default: 'none',
        },
        billType: {
          type: String,
          enum: ['cash', 'card'],
        },
        requestedAt: { type: Date },
        acknowledgedAt: { type: Date },
        acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
      kitchenStartedAt: { type: Date },
      readyAt: { type: Date },
      // Immutable preparation-area estimates shown on the customer's live
      // status. They are refreshed only for the areas affected by a newly
      // printed QR add-on, so a Bar add-on does not restart Kitchen's timer.
      preparationCategories: {
        type: [{
          _id: false,
          key: { type: String, trim: true, required: true },
          name: { type: String, trim: true, required: true },
          preparationMinutes: { type: Number, min: 0, max: 240, required: true },
          menuCategoryIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' }],
            default: [],
          },
          kitchenStartedAt: { type: Date, required: true },
          readyAt: { type: Date, required: true },
        }],
        default: [],
      },
      // Category IDs belonging to the exact ticket awaiting connector
      // confirmation. Used to restart only the matching area timers.
      pendingKitchenCategoryIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' }],
        default: [],
      },
      pendingKitchenHasUnassigned: { type: Boolean, default: false },
    },
    // Staff tablet provenance. The device is stored in the platform registry,
    // so its id is snapshotted as a string rather than a cross-db ObjectId ref.
    staffOrder: {
      deviceId: { type: String, trim: true },
      deviceLabel: { type: String, trim: true },
      waiterName: { type: String, trim: true },
      submittedAt: { type: Date },
    },
    // Set when status === 'refunded' — the session close aggregation reads this.
    // P2-03 compatibility: isRefund:true means this row decrements netCash/sales totals.
    isRefund: {
      type: Boolean,
      default: false,
    },
    heldAt: { type: Date },
    // Set when a delivery order is dispatched unpaid (status 'out-for-delivery').
    dispatchedAt: { type: Date },
    // Set when the rider's payment is collected and the order is finalised.
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    settledAt: { type: Date },
    voidReason: { type: String, trim: true },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    voidedAt: { type: Date },
    // Explicit kitchen status chosen when a held order is cancelled.
    // Null means the cancellation came from a flow that does not ask this
    // question (for example, voiding an already-completed sale).
    wasPreparedAtCancellation: { type: Boolean, default: null },
    // Operating date on which the cancellation happened. This is intentionally
    // separate from `businessDate`, which remains the order's original sale day.
    voidBusinessDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    refundReason: { type: String, trim: true },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    // Private POS reminder for the cashier. Kept separate from `notes` so it
    // is never treated as a kitchen instruction or rendered on a receipt.
    cashierNotes: { type: String, trim: true, maxlength: 500, default: '' },

    // ── Offline / Sync ─────────────────────────────────────────────────────────
    // Client-generated UUID used to deduplicate offline-queue submissions.
    clientTransactionId: {
      type: String,
      trim: true,
    },
    offlineSync: {
      queuedAt: { type: Date },
      originalSession: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleSession' },
      originalCashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      syncedAt: { type: Date },
      clientTotal: { type: Number, min: 0 },
      amountAdjustment: {
        originalTotal: { type: Number, min: 0 },
        correctedTotal: { type: Number, min: 0 },
        shortfall: { type: Number, min: 0 },
        confirmedAt: { type: Date },
      },
    },

    // ── Accounting ─────────────────────────────────────────────────────────────
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    },
    syncedToManagement: {
      type: Boolean,
      default: true,
    },
    syncedAt: {
      type: Date,
    },
    receiptPrinted: {
      type: Boolean,
      default: false,
    },

    // ── Waste / Loss tracking ──────────────────────────────────────────────────
    // True when the order is FULLY wasted (every line's wastedQty has reached its
    // qty). Partial waste leaves this false and sets partiallyWasted instead.
    // Waste events link back via WasteLog.saleTransactionId (an order can have
    // several when wasted incrementally).
    isVoidedAsWaste: {
      type: Boolean,
      default: false,
    },
    // True when some — but not all — units of the order have been wasted.
    partiallyWasted: {
      type: Boolean,
      default: false,
    },
    // Most recent waste event for this order (an order may have several).
    wasteLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WasteLog',
      default: null,
    },
    // True when the wasted order was re-cooked for the customer (stock was
    // deducted a second time so the on-hand count stays exact).
    rePrepared: {
      type: Boolean,
      default: false,
    },
    // Legacy federal DI result retained for historical transactions.
    fbr: {
      status: { type: String, enum: ['pending', 'reported', 'failed', 'skipped', 'submitting'] },
      invoiceNumber: { type: String },
      error: { type: String },
      mode: { type: String },
      submittedAt: { type: Date },
    },
    // PRA eIMS fiscal result. A completed sale uses InvoiceType=1. If a PRA-
    // reported sale is later voided/refunded, `credit` records the corresponding
    // InvoiceType=3 submission whose RefUSIN points to the original USIN.
    pra: {
      status: { type: String, enum: ['pending', 'reported', 'failed', 'skipped', 'submitting'] },
      invoiceNumber: { type: String },
      responseCode: { type: String },
      error: { type: String },
      mode: { type: String, enum: ['sandbox', 'production'] },
      usin: { type: String, maxlength: 50 },
      submittedAt: { type: Date },
      credit: {
        status: { type: String, enum: ['pending', 'reported', 'failed', 'skipped', 'submitting'] },
        invoiceNumber: { type: String },
        responseCode: { type: String },
        error: { type: String },
        mode: { type: String, enum: ['sandbox', 'production'] },
        usin: { type: String, maxlength: 50 },
        refUsin: { type: String, maxlength: 50 },
        requestedAt: { type: Date },
        submittedAt: { type: Date },
      },
    },
    // ── Order type & customer ──────────────────────────────────────────────────
    orderType: {
      type: String,
      enum: ['dine-in', 'takeaway', 'delivery', 'foodpanda'],
      default: 'dine-in',
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    tableNumber: { type: String, trim: true, default: '' },
    // Set when the kitchen ticket has been confirmed printed by the cashier.
    // Null on a fresh hold; populated either from the print modal's
    // success branch or by a later "reprint" action. Drives whether the
    // resume flow shows a Send-to-Kitchen button.
    kitchenPrintedAt: { type: Date, default: null },
    // A durable server print job exists but may not yet have reached the
    // Windows spooler. This prevents the cashier from manually sending a
    // duplicate KOT during the short queued/claimed window.
    kitchenPrintQueuedAt: { type: Date, default: null },
    // Quantities already sent to the kitchen, keyed as menuItemId::variationId.
    // This lets a resumed/updated hold print only newly added quantities.
    kitchenPrintedQtyMap: { type: Map, of: Number, default: {} },
    // Snapshot of the delivery address chosen at sale time (independent of
    // Customer.addresses so historical records stay accurate after edits).
    deliveryAddress: {
      label: { type: String, trim: true },
      street: { type: String, trim: true },
      area: { type: String, trim: true },
      city: { type: String, trim: true },
    },
    assignedRider: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    // User-based rider assignment used only when the riderTracking feature is
    // enabled. The legacy Employee reference above remains intact so disabled
    // outlets and historical rows preserve their existing behaviour.
    assignedRiderUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedRiderAt: { type: Date, default: null },
    assignedRiderBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    riderDeliveryStatus: {
      type: String,
      enum: ['assigned', 'accepted', 'picked_up', 'delivered', 'delivery_failed', 'returned_to_restaurant'],
      default: undefined,
    },
    // Stable link to the operational kitchen lifecycle. It is copied from a
    // held order to the final paid transaction before the held row is removed.
    kdsOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'KdsOrder', default: null },

    // ── Membership / Rewards ──────────────────────────────────────────────
    // Snapshot of points activity for this sale. All zero unless the
    // membershipRewards feature was enabled and a customer was attached.
    pointsEarned: { type: Number, default: 0, min: 0 },
    pointsRedeemed: { type: Number, default: 0, min: 0 },
    pointsRedeemedValue: { type: Number, default: 0, min: 0 },
    loyaltyEarnEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    // ── Split-the-bill ────────────────────────────────────────────────────
    // When paymentMethod === 'split-bill', this holds the per-person break-
    // down. cashAmount/cardAmount above are still set (sums of cash/card
    // parts) so existing reports and journal entries keep working unchanged.
    //
    // Each part:
    //   share        — what this person owes after split + edits + merges
    //   method       — 'cash' | 'card' | 'covered'
    //   tendered     — only for cash (>= share, change = tendered - share)
    //   change       — for cash, what was given back
    //   cardReference— optional last-4 / approval code for card
    //   coveredBy    — index into parts of the tile that covered this one
    //   note         — free text the cashier can attach (e.g. "covered Person 4")
    splitBill: {
      ways: { type: Number, default: 0, min: 0 },
      parts: {
        type: [
          new mongoose.Schema(
            {
              share: { type: Number, default: 0, min: 0 },
              method: { type: String, enum: ['cash', 'card', 'covered'] },
              tendered: { type: Number, default: 0, min: 0 },
              change: { type: Number, default: 0, min: 0 },
              cardReference: { type: String, trim: true, default: '' },
              coveredBy: { type: Number, default: null },
              note: { type: String, trim: true, default: '' },
              paidAt: { type: Date },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

saleTransactionSchema.index({ outlet: 1, session: 1 });
saleTransactionSchema.index({ outlet: 1, createdAt: -1 });
saleTransactionSchema.index({ shopifyOrderId: 1 }, { unique: true, sparse: true });
saleTransactionSchema.index({ outlet: 1, businessDate: -1 });
saleTransactionSchema.index({ outlet: 1, voidBusinessDate: -1 });
saleTransactionSchema.index({ cashier: 1, createdAt: -1 });
saleTransactionSchema.index({ session: 1, status: 1 });
saleTransactionSchema.index({ status: 1 });
// POS availability and held-order screens both query the active held set by
// outlet. This keeps those reads proportional to the live kitchen queue rather
// than the tenant's lifetime transaction count.
saleTransactionSchema.index({ outlet: 1, status: 1, heldAt: -1 });
// Sparse so null clientTransactionId rows are not indexed (most online sales won't set it)
saleTransactionSchema.index({ clientTransactionId: 1 }, { unique: true, sparse: true });

// Legacy FBR retry index retained until historical federal submissions are
// archived. New PRA retry indexes cover original and credit invoices.
saleTransactionSchema.index(
  { 'fbr.status': 1, createdAt: 1 },
  { partialFilterExpression: { 'fbr.status': 'pending' } },
);
saleTransactionSchema.index(
  { 'pra.status': 1, createdAt: 1 },
  { partialFilterExpression: { 'pra.status': 'pending' } },
);
saleTransactionSchema.index(
  { 'pra.credit.status': 1, voidedAt: 1 },
  { partialFilterExpression: { 'pra.credit.status': 'pending' } },
);

// ─── Pre-save: auto-generate transaction number ────────────────────────────────

saleTransactionSchema.pre('save', async function () {
  if (this.isNew && !this.businessDate && this.outlet) {
    const outlet = await this.constructor.db.model('Outlet').findById(this.outlet)
      .select('timezone businessDayStart businessDayEnd').lean();
    this.businessDate = getBusinessDate(
      this.createdAt || new Date(),
      outlet?.timezone || 'Asia/Karachi',
      outlet?.businessDayStart || '00:00',
      outlet?.businessDayEnd || outlet?.businessDayStart || '00:00',
    );
  }
  if (!this.isNew || this.transactionNumber) return;
  this.transactionNumber = await generateTransactionNumber(this.businessDate);
});

const SaleTransaction = defineModel('SaleTransaction', saleTransactionSchema);

export default SaleTransaction;
