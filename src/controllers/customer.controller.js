import Customer from '../models/Customer.js';

// ─── GET /api/customers/search?phone=<query> ──────────────────────────────────
// Cashier searches by phone (partial match).
// Returns up to 10 matches.
export const searchCustomers = async (req, res) => {
    const { phone } = req.query;
    if (!phone || phone.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Provide at least 3 digits to search.' });
    }

    const escaped = phone.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const customers = await Customer.find({
        phone: { $regex: escaped, $options: 'i' },
    })
        .select('name phone email addresses pointsBalance lifetimePointsEarned lifetimePointsRedeemed membershipCardNumber membershipCardIssuedAt pointsExpireAt')
        .limit(10)
        .lean();

    return res.json({ success: true, data: customers });
};

// ─── GET /api/customers/:id ───────────────────────────────────────────────────
export const getCustomer = async (req, res) => {
    const customer = await Customer.findById(req.params.id)
        .select('name phone email addresses pointsBalance lifetimePointsEarned lifetimePointsRedeemed membershipCardNumber membershipCardIssuedAt pointsExpireAt')
        .lean();
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
    }
    return res.json({ success: true, data: customer });
};

// ─── POST /api/customers ──────────────────────────────────────────────────────
// Create or update by phone.  If phone already exists, update name/email.
export const upsertCustomer = async (req, res) => {
    const { phone, name, email } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, message: 'phone is required.' });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;

    const customer = await Customer.findOneAndUpdate(
        { phone: phone.trim() },
        { $set: update, $setOnInsert: { phone: phone.trim() } },
        { upsert: true, returnDocument: 'after', runValidators: true }
    ).select('name phone email addresses pointsBalance lifetimePointsEarned lifetimePointsRedeemed membershipCardNumber membershipCardIssuedAt pointsExpireAt');

    return res.status(200).json({ success: true, data: customer });
};

// ─── POST /api/customers/:id/addresses ───────────────────────────────────────
// Add a new address to a customer.
export const addAddress = async (req, res) => {
    const { label, street, area, city, isDefault } = req.body;

    const customer = await Customer.findById(req.params.id);
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    // If new address is default, unset all others.
    if (isDefault) {
        customer.addresses.forEach((a) => { a.isDefault = false; });
    }

    customer.addresses.push({ label, street, area, city, isDefault: !!isDefault });
    await customer.save();

    return res.status(201).json({ success: true, data: customer.addresses });
};

// ─── PATCH /api/customers/:id/addresses/:addressId ────────────────────────────
// Update an existing saved delivery address.
export const updateAddress = async (req, res) => {
    const { label, street, area, city, isDefault } = req.body;
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const address = customer.addresses.id(req.params.addressId);
    if (!address) {
        return res.status(404).json({ success: false, message: 'Address not found.' });
    }

    if (isDefault === true) {
        customer.addresses.forEach((row) => { row.isDefault = false; });
    }
    if (label !== undefined) address.label = label;
    if (street !== undefined) address.street = street;
    if (area !== undefined) address.area = area;
    if (city !== undefined) address.city = city;
    if (isDefault !== undefined) address.isDefault = !!isDefault;

    await customer.save();
    return res.json({ success: true, data: customer.addresses });
};

// ─── PATCH /api/customers/:id ─────────────────────────────────────────────────
// Update name / email.
export const updateCustomer = async (req, res) => {
    const { name, email } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;

    const customer = await Customer.findByIdAndUpdate(
        req.params.id,
        { $set: update },
        { returnDocument: 'after', runValidators: true }
    ).select('name phone email addresses pointsBalance lifetimePointsEarned lifetimePointsRedeemed membershipCardNumber membershipCardIssuedAt pointsExpireAt');

    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
    }
    return res.json({ success: true, data: customer });
};
