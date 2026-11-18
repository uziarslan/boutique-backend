import 'dotenv/config';
import connectDB from '../config/db.js';
import User from '../models/User.js';

const EMAIL = process.env.LIST_EMAIL || 'owner@example.com';

const main = async () => {
    await connectDB();
    try {
        const users = await User.find({ email: { $regex: `^${EMAIL}$`, $options: 'i' } }).lean();
        console.log(`Found ${users.length} users matching ${EMAIL}:`);
        users.forEach((u, i) => console.log(i + 1, { id: u._id?.toString(), email: u.email, role: u.role, isActive: u.isActive }));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
};

main();
