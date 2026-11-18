import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';

const DEFAULT_EMAIL = process.env.PURCHASE_EMAIL || 'purchase@example.com';
const DEFAULT_PASSWORD = process.env.PURCHASE_EMAIL_PASSWORD || process.env.DEFAULT_PASSWORD || 'password123';
const DEFAULT_NAME = process.env.PURCHASE_EMAIL_NAME || 'Purchase Manager';

const main = async () => {
    await connectDB();
    try {
        const exists = await User.findOne({ email: DEFAULT_EMAIL }).exec();
        if (exists) {
            console.log(`User exists: ${DEFAULT_EMAIL} (role: ${exists.role}) — skipping`);
        } else {
            const user = await User.create({ name: DEFAULT_NAME, email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD, role: 'purchaseManager', isActive: true });
            console.log(`Created purchase manager: ${DEFAULT_EMAIL} (id: ${user._id})`);
        }
    } catch (err) {
        console.error('Error creating purchase manager:', err);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from DB.');
    }
};

main();
