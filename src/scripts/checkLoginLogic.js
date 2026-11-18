import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import bcrypt from 'bcryptjs';

const EMAIL = process.env.CHECK_EMAIL || 'owner@example.com';
const PASSWORD = process.env.CHECK_PASSWORD || 'password123';

const main = async () => {
    await connectDB();
    try {
        const user = await User.findOne({ email: EMAIL }).select('+password outlet isActive');
        if (!user) {
            console.log('No user found for', EMAIL);
            return;
        }
        console.log('Found user:', { id: user._id.toString(), email: user.email, role: user.role, isActive: user.isActive });
        const pwMatch = await bcrypt.compare(PASSWORD, user.password);
        console.log('Password match:', pwMatch);
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

main();
