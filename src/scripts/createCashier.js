import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import Outlet from '../models/Outlet.js';

const DEFAULT_EMAIL = process.env.CASHIER_EMAIL || 'cashier@example.com';
const DEFAULT_PASSWORD = process.env.CASHIER_EMAIL_PASSWORD || process.env.DEFAULT_PASSWORD || 'password123';
const DEFAULT_NAME = process.env.CASHIER_EMAIL_NAME || 'Cashier';
const OUTLET_CODE = process.env.OUTLET_CODE || 'REST-001';
const OUTLET_NAME = process.env.OUTLET_NAME || 'Main Branch';

const ensureOutlet = async (code, name) => {
    const _code = code.toUpperCase();
    let out = await Outlet.findOne({ code: _code }).exec();
    if (out) return out;
    console.log(`Creating outlet ${_code} (${name})`);
    return Outlet.create({ name, code: _code });
};

const main = async () => {
    await connectDB();
    try {
        const outlet = await ensureOutlet(OUTLET_CODE, OUTLET_NAME);
        const exists = await User.findOne({ email: DEFAULT_EMAIL }).exec();
        if (exists) {
            console.log(`User exists: ${DEFAULT_EMAIL} (role: ${exists.role}) — skipping`);
        } else {
            const user = await User.create({ name: DEFAULT_NAME, email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD, role: 'cashier', isActive: true, outlet: outlet.code, outletRef: outlet._id });
            console.log(`Created cashier: ${DEFAULT_EMAIL} (id: ${user._id}) assigned to outlet ${outlet.code}`);
        }
    } catch (err) {
        console.error('Error creating cashier:', err);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from DB.');
    }
};

main();
