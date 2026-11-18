import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';

const EMAIL = process.env.SHOW_USER_EMAIL || 'owner@example.com';

const main = async () => {
    await connectDB();
    try {
        const user = await User.findOne({ email: EMAIL }).select('+password +isActive');
        if (!user) {
            console.log(`User not found: ${EMAIL}`);
        } else {
            console.log('User document:');
            console.log({ id: user._id.toString(), email: user.email, role: user.role, isActive: user.isActive, outlet: user.outlet, outletRef: user.outletRef });
        }
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

main();
