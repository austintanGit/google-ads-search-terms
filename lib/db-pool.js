require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const sslCertPath = process.env.DB_SSL_CERT || '/certs/global-bundle.pem';
const dbPool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: fs.existsSync(sslCertPath)
        ? { rejectUnauthorized: true, ca: fs.readFileSync(sslCertPath).toString() }
        : { rejectUnauthorized: false },
});

module.exports = { dbPool };
