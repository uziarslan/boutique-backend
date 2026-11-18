import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';

const EMAIL = process.env.ACTIVATE_EMAIL || 'owner@example.com';

const main = async () => {
    await connectDB();
    try {
        const user = await User.findOne({ email: EMAIL }).exec();
        if (!user) {
            console.log(`User not found: ${EMAIL}`);
        } else {
            user.isActive = true;
            await user.save({ validateBeforeSave: false });
            console.log(`User activated: ${EMAIL}`);
        }
    } catch (err) {
        console.error('Error activating user:', err);
    } finally {
        await mongoose.disconnect();
    }
};

main();
