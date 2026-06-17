#!/usr/bin/env node
/**
 * Remove a stale users row so someone can register again after Cognito deletion.
 * Also useful when Cognito was deleted but the app DB still has rejected/pending state.
 *
 * Usage: node scripts/reset-user-for-reregister.js <email>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { dbPool } = require('../lib/db-pool');

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/reset-user-for-reregister.js <email>');
    process.exit(1);
}

async function main() {
    const existing = await dbPool.query(
        'SELECT id, email, status, is_super_user FROM users WHERE email = $1',
        [email]
    );
    if (existing.rows.length === 0) {
        console.log(`No users row for ${email}. If Cognito is also clear, registration should work.`);
        return;
    }

    const row = existing.rows[0];
    if (row.status === 'approved' && row.is_super_user) {
        console.error(`Refusing to delete approved super user ${email}. Reset Cognito only or use bootstrap-super-user.sh.`);
        process.exit(1);
    }

    await dbPool.query('DELETE FROM users WHERE email = $1', [email]);
    console.log(`Deleted users row for ${email} (was status=${row.status}).`);
    console.log('Ensure the user is also deleted in AWS Cognito, then register again.');
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => dbPool.end());
