import axios from 'axios';

const URL = process.env.API_URL || 'http://localhost:4000';
const email = process.env.TEST_EMAIL || 'owner@example.com';
const password = process.env.TEST_PASSWORD || 'password123';

(async () => {
    try {
        const res = await axios.post(`${URL}/api/auth/login`, { email, password }, { withCredentials: true });
        console.log('Login response:', res.data);
    } catch (err) {
        if (err.response) console.error('Error:', err.response.status, err.response.data);
        else console.error(err.message);
    }
})();
