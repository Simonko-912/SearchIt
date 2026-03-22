require('dotenv').config();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
module.exports = { ADMIN_TOKEN };
