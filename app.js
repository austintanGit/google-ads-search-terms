require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { GoogleAdsApi } = require('google-ads-api');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const cheerio = require('cheerio');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>')
        .trim();
}

function safeHttpUrl(url) {
    const u = String(url || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
}

function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Email address from `notifications@domain` or `"Name" <notifications@domain>`. */
function extractMailbox(fromEnv) {
    if (!fromEnv || typeof fromEnv !== 'string') return '';
    const t = fromEnv.trim();
    const angled = t.match(/<([^<>]+@[^<>]+)>/);
    if (angled) return angled[1].trim();
    if (/^[^\s<>]+@[^\s<>]+$/.test(t)) return t;
    return '';
}

/** From: `[Agency Name] via Pirate Fuse` <mailbox> */
function pirateFuseSesSource(mailbox, agencyName) {
    const namePart =
        String(agencyName == null ? '' : agencyName)
            .replace(/[\r\n\x00]/g, ' ')
            .replace(/"/g, '')
            .trim() || 'Agency';
    const displayName = `${namePart} via Pirate Fuse`;
    return `"${displayName}" <${mailbox}>`;
}

/** Normalize search text for comparing AI suggestions against account search terms. */
function normalizeSearchQueryForAi(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Drop sloppy model output: generic junk (rule 3), or pasting an entire multi-word query back as the negative.
 */
function shouldDropAiNegativeSuggestion(keyword, searchTerms) {
    const t = typeof keyword === 'string' ? keyword.trim() : '';
    if (!t) return true;
    const low = t.toLowerCase();
    // Rule 3 — never negate generic local intent fluff in the keyword string itself
    if (/\bnear\s+me\b/.test(low)) return true;

    const wordCount = low.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 3) {
        const kn = normalizeSearchQueryForAi(t);
        if (searchTerms.some((st) => normalizeSearchQueryForAi(st.searchTerm) === kn)) {
            return true;
        }
    }
    return false;
}

function extractFirstJsonObject(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

// Import authentication functions
const { 
    authenticateToken,
    requireSuperUser,
    loginUser, 
    registerUser, 
    confirmRegistration, 
    forgotPassword, 
    resetPassword,
    createUserInDB,
    getUserByEmail
} = require('./auth');

// ===== Review request flow constants & helpers =====

const REVIEW_STATUSES = Object.freeze({
    PENDING_CLIENT: 'pending_client',
    CLIENT_SUBMITTED: 'client_submitted',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    APPROVED_BY_STRATEGIST: 'approved_by_strategist',
    REJECTED_BY_STRATEGIST: 'rejected_by_strategist',
});

const REVIEW_DEFAULT_EXPIRY_DAYS = 7;
const REVIEW_MAX_EXPIRY_DAYS = 30;
const REVIEW_DECISIONS = Object.freeze(new Set(['block', 'keep']));

/** Raw 32-byte URL-safe token; only the sha256 hash is persisted. */
function generateReviewToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashReviewToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** Public app base URL for review links (env > forwarded headers > host header). */
function buildAppBaseUrl(req) {
    const envBase = (process.env.PUBLIC_APP_BASE_URL || '').trim();
    if (envBase) return envBase.replace(/\/$/, '');
    if (req?.headers?.origin) return String(req.headers.origin).replace(/\/$/, '');
    if (req) {
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] || req.get?.('host') || '').toString().split(',')[0].trim();
        if (host) return `${proto}://${host}`;
    }
    return '';
}

function clampExpirationDays(input) {
    const n = Number.parseInt(input, 10);
    if (!Number.isFinite(n) || n <= 0) return REVIEW_DEFAULT_EXPIRY_DAYS;
    return Math.min(REVIEW_MAX_EXPIRY_DAYS, Math.max(1, n));
}

// PostgreSQL connection pool
const sslCertPath = process.env.DB_SSL_CERT || '/certs/global-bundle.pem';
const dbPool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: fs.existsSync(sslCertPath)
        ? { rejectUnauthorized: true, ca: fs.readFileSync(sslCertPath).toString() }
        : { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                cognito_sub VARCHAR(255),
                status VARCHAR(20) DEFAULT 'pending',
                is_super_user BOOLEAN DEFAULT FALSE,
                approved_by VARCHAR(255),
                approved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS client_website_urls (
                client_id VARCHAR(30) PRIMARY KEY,
                website_url TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS client_saved_negatives (
                id SERIAL PRIMARY KEY,
                client_id VARCHAR(30) NOT NULL,
                keyword TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(client_id, keyword)
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS client_default_shared_sets (
                client_id VARCHAR(30) PRIMARY KEY,
                shared_set_id TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS client_pending_state (
                client_id VARCHAR(30) NOT NULL,
                keyword TEXT NOT NULL,
                match_type VARCHAR(10) NOT NULL DEFAULT 'EXACT',
                destination VARCHAR(20) NOT NULL DEFAULT 'NEGATIVE_LIST',
                shared_set_id TEXT,
                source VARCHAR(10) NOT NULL DEFAULT 'manual',
                selected BOOLEAN NOT NULL DEFAULT true,
                campaign_id TEXT,
                campaign_name TEXT,
                ad_group_id TEXT,
                ad_group_name TEXT,
                saved_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (client_id, keyword, match_type)
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS submission_history (
                id SERIAL PRIMARY KEY,
                client_id VARCHAR(30) NOT NULL,
                submitted_at TIMESTAMP DEFAULT NOW(),
                keyword_count INTEGER NOT NULL,
                list_name TEXT,
                match_types TEXT,
                keywords JSONB NOT NULL,
                submitted_by_email VARCHAR(255),
                submitted_by_name VARCHAR(255)
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS review_requests (
                id UUID PRIMARY KEY,
                token_hash VARCHAR(64) NOT NULL UNIQUE,
                client_id VARCHAR(30) NOT NULL,
                client_name TEXT,
                requested_by_email VARCHAR(255),
                requested_by_name VARCHAR(255),
                recipient_email VARCHAR(255),
                status VARCHAR(40) NOT NULL DEFAULT 'pending_client',
                expires_at TIMESTAMP NOT NULL,
                submitted_at TIMESTAMP,
                approved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await dbPool.query(`
            CREATE INDEX IF NOT EXISTS review_requests_status_idx
            ON review_requests (status)
        `);
        await dbPool.query(`
            CREATE INDEX IF NOT EXISTS review_requests_client_id_idx
            ON review_requests (client_id)
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS review_request_items (
                id SERIAL PRIMARY KEY,
                review_request_id UUID NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
                keyword TEXT NOT NULL,
                match_type VARCHAR(10) NOT NULL DEFAULT 'PHRASE',
                destination VARCHAR(20) NOT NULL DEFAULT 'NEGATIVE_LIST',
                campaign_id TEXT,
                campaign_name TEXT,
                ad_group_id TEXT,
                ad_group_name TEXT,
                shared_set_id TEXT,
                source_meta JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await dbPool.query(`
            CREATE INDEX IF NOT EXISTS review_request_items_request_idx
            ON review_request_items (review_request_id)
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS review_request_decisions (
                review_request_item_id INTEGER PRIMARY KEY REFERENCES review_request_items(id) ON DELETE CASCADE,
                decision VARCHAR(10) NOT NULL,
                decided_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Migration: Add new columns if they don't exist
        try {
            await dbPool.query(`
                ALTER TABLE submission_history 
                ADD COLUMN IF NOT EXISTS submitted_by_email VARCHAR(255)
            `);
            await dbPool.query(`
                ALTER TABLE submission_history 
                ADD COLUMN IF NOT EXISTS submitted_by_name VARCHAR(255)
            `);
            // Migration: add campaign/adgroup columns to client_pending_state
            await dbPool.query(`ALTER TABLE client_pending_state ADD COLUMN IF NOT EXISTS campaign_id TEXT`);
            await dbPool.query(`ALTER TABLE client_pending_state ADD COLUMN IF NOT EXISTS campaign_name TEXT`);
            await dbPool.query(`ALTER TABLE client_pending_state ADD COLUMN IF NOT EXISTS ad_group_id TEXT`);
            await dbPool.query(`ALTER TABLE client_pending_state ADD COLUMN IF NOT EXISTS ad_group_name TEXT`);
            await dbPool.query(`
                UPDATE client_pending_state
                SET match_type = CASE
                  WHEN trim(coalesce(match_type, '')) = '' THEN 'PHRASE'
                  ELSE upper(trim(match_type))
                END
            `);
            const pendingPkCols = await dbPool.query(`
                SELECT kcu.column_name
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                    ON tc.constraint_schema = kcu.constraint_schema
                   AND tc.constraint_name = kcu.constraint_name
                   AND tc.table_name = kcu.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = 'public'
                  AND tc.table_name = 'client_pending_state'
                  AND kcu.table_schema = 'public'
                  AND kcu.table_name = 'client_pending_state'
                ORDER BY kcu.ordinal_position ASC
            `);
            const pendingPkKey = pendingPkCols.rows.map((r) => r.column_name).join(',');
            if (pendingPkKey !== 'client_id,keyword,match_type') {
                await dbPool.query(`
                    DELETE FROM client_pending_state a USING client_pending_state b
                    WHERE a.client_id = b.client_id
                      AND a.keyword = b.keyword
                      AND a.match_type = b.match_type
                      AND a.ctid < b.ctid
                `);
                await dbPool.query(`
                    ALTER TABLE client_pending_state DROP CONSTRAINT IF EXISTS client_pending_state_pkey
                `).catch(() => {});
                await dbPool.query(`
                    ALTER TABLE client_pending_state ADD PRIMARY KEY (client_id, keyword, match_type)
                `);
            }
            console.log('Database migration completed: added user tracking columns');
        } catch (migrationError) {
            console.log('Migration note:', migrationError.message);
        }
        
        console.log('DB tables initialized');
    } catch (err) {
        console.error('DB init error:', err.message);
    }
}
initDB();

const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Retry helper for transient Google Ads API errors (e.g. CONCURRENT_MODIFICATION)
async function withRetry(fn, maxAttempts = 3, delayMs = 1500) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const errMsg = err.message || '';
            const isConcurrent =
                err.errors?.some(e =>
                    e.error_code?.mutate_error === 'CONCURRENT_MODIFICATION' ||
                    /concurrent/i.test(e.message || '') ||
                    /modify the same resource/i.test(e.message || '')
                ) ||
                /concurrent/i.test(errMsg) ||
                /modify the same resource/i.test(errMsg);

            if (isConcurrent && attempt < maxAttempts) {
                console.log(`[retry] CONCURRENT_MODIFICATION on attempt ${attempt}, retrying in ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
            } else if (isConcurrent) {
                // All retries exhausted — surface a friendly message
                const friendly = new Error('Google Ads is temporarily busy — please wait a moment and click Submit again.');
                friendly.isFriendly = true;
                throw friendly;
            } else {
                throw err;
            }
        }
    }
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve React build files
app.use(express.static('public'));

// Initialize Google Ads API client
let client;
try {
    client = new GoogleAdsApi({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    });
    console.log('Google Ads client initialized successfully');
} catch (error) {
    console.error('Error initializing Google Ads API:', error);
    process.exit(1);
}

// ===== AUTHENTICATION ROUTES =====

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await loginUser(email, password, dbPool);
        res.json(result);
    } catch (error) {
        console.error('Login error:', error);
        
        if (error.name === 'NotAuthorizedException') {
            res.status(401).json({ error: 'Invalid email or password' });
        } else if (error.name === 'UserNotConfirmedException') {
            res.status(401).json({ error: 'Please confirm your email address first' });
        } else {
            res.status(500).json({ error: 'Login failed', details: error.message });
        }
    }
});

// Register endpoint
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await registerUser(email, password, name);
        
        // Create user record in database after successful Cognito registration
        if (result.success) {
            await createUserInDB(email, name, result.userSub, dbPool);
        }
        
        res.json(result);
    } catch (error) {
        console.error('Registration error:', error);
        
        if (error.name === 'UsernameExistsException') {
            res.status(400).json({ error: 'An account with this email already exists' });
        } else if (error.name === 'InvalidPasswordException') {
            res.status(400).json({ error: 'Password does not meet requirements' });
        } else {
            res.status(500).json({ error: 'Registration failed', details: error.message });
        }
    }
});

// Confirm registration endpoint
app.post('/api/auth/confirm', async (req, res) => {
    try {
        const { email, confirmationCode } = req.body;
        
        if (!email || !confirmationCode) {
            return res.status(400).json({ error: 'Email and confirmation code are required' });
        }

        const result = await confirmRegistration(email, confirmationCode);
        res.json(result);
    } catch (error) {
        console.error('Confirmation error:', error);
        
        if (error.name === 'CodeMismatchException') {
            res.status(400).json({ error: 'Invalid confirmation code' });
        } else if (error.name === 'ExpiredCodeException') {
            res.status(400).json({ error: 'Confirmation code has expired' });
        } else {
            res.status(500).json({ error: 'Confirmation failed', details: error.message });
        }
    }
});

// Forgot password endpoint
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const result = await forgotPassword(email);
        res.json(result);
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to send reset code', details: error.message });
    }
});

// Reset password endpoint
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, confirmationCode, newPassword } = req.body;
        
        if (!email || !confirmationCode || !newPassword) {
            return res.status(400).json({ error: 'Email, confirmation code, and new password are required' });
        }

        const result = await resetPassword(email, confirmationCode, newPassword);
        res.json(result);
    } catch (error) {
        console.error('Reset password error:', error);
        
        if (error.name === 'CodeMismatchException') {
            res.status(400).json({ error: 'Invalid confirmation code' });
        } else if (error.name === 'ExpiredCodeException') {
            res.status(400).json({ error: 'Confirmation code has expired' });
        } else {
            res.status(500).json({ error: 'Password reset failed', details: error.message });
        }
    }
});

// Logout endpoint
app.post('/api/auth/logout', authenticateToken, (req, res) => {
    // Since JWTs are stateless, logout is handled client-side by removing the token
    res.json({ success: true, message: 'Logged out successfully' });
});

// Get current user info
app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({ 
        success: true, 
        user: { 
            email: req.user.email,
            name: req.user.name || ''
        } 
    });
});

// ===== END AUTHENTICATION ROUTES =====

// ===== ADMIN ROUTES (Super User Only) =====

// Get pending users
app.get('/api/admin/pending-users', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const result = await dbPool.query(
            `SELECT id, email, name, status, created_at 
             FROM users 
             WHERE status = 'pending' 
             ORDER BY created_at ASC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching pending users:', error);
        res.status(500).json({ error: 'Failed to fetch pending users', details: error.message });
    }
});

// Get all users
app.get('/api/admin/users', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const result = await dbPool.query(
            `SELECT id, email, name, status, is_super_user, approved_by, approved_at, created_at 
             FROM users 
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users', details: error.message });
    }
});

// Approve user
app.post('/api/admin/approve-user', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const result = await dbPool.query(
            `UPDATE users 
             SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
             WHERE id = $2 
             RETURNING id, email, name, status`,
            [req.user.email, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        console.log(`User ${result.rows[0].email} approved by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `User ${result.rows[0].email} has been approved`,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error approving user:', error);
        res.status(500).json({ error: 'Failed to approve user', details: error.message });
    }
});

// Reject user
app.post('/api/admin/reject-user', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const result = await dbPool.query(
            `UPDATE users 
             SET status = 'rejected', approved_by = $1, approved_at = NOW(), updated_at = NOW()
             WHERE id = $2 
             RETURNING id, email, name, status`,
            [req.user.email, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        console.log(`User ${result.rows[0].email} rejected by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `User ${result.rows[0].email} has been rejected`,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error rejecting user:', error);
        res.status(500).json({ error: 'Failed to reject user', details: error.message });
    }
});

// Make user super user
app.post('/api/admin/make-super-user', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const result = await dbPool.query(
            `UPDATE users 
             SET is_super_user = true, updated_at = NOW()
             WHERE id = $1 
             RETURNING id, email, name, is_super_user`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        console.log(`User ${result.rows[0].email} granted super user by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `User ${result.rows[0].email} is now a super user`,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error making user super user:', error);
        res.status(500).json({ error: 'Failed to make user super user', details: error.message });
    }
});

// Remove super user status
app.post('/api/admin/remove-super-user', authenticateToken, requireSuperUser, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        // Prevent removing super user status from self
        if (parseInt(userId) === req.user.userId) {
            return res.status(400).json({ error: 'Cannot remove super user status from yourself' });
        }

        const result = await dbPool.query(
            `UPDATE users 
             SET is_super_user = false, updated_at = NOW()
             WHERE id = $1 
             RETURNING id, email, name, is_super_user`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        console.log(`Super user status removed from ${result.rows[0].email} by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `Super user status removed from ${result.rows[0].email}`,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error removing super user:', error);
        res.status(500).json({ error: 'Failed to remove super user status', details: error.message });
    }
});

// ===== END ADMIN ROUTES =====

// Protected API routes - require authentication
app.use('/api/clients', authenticateToken);
app.use('/api/search-terms', authenticateToken);
app.use('/api/negative-keywords', authenticateToken);
app.use('/api/shared-sets', authenticateToken);
app.use('/api/create-shared-set', authenticateToken);
app.use('/api/add-to-exclusion-list', authenticateToken);
app.use('/api/ai-recommend-negatives', authenticateToken);
app.use('/api/detect-website', authenticateToken);
app.use('/api/client-settings', authenticateToken);
app.use('/api/client-website-url', authenticateToken);
app.use('/api/client-default-shared-set', authenticateToken);
app.use('/api/client-saved-negatives', authenticateToken);
app.use('/api/submission-history', authenticateToken);
app.use('/api/campaigns', authenticateToken);
app.use('/api/adgroups', authenticateToken);
app.use('/api/add-campaign-negative', authenticateToken);
app.use('/api/add-adgroup-negative', authenticateToken);
app.use('/api/remove-google-negative', authenticateToken);
app.use('/api/apply-list-to-campaigns', authenticateToken);
app.use('/api/review-requests', authenticateToken);

// Send pending-negative approval email via Amazon SES
app.post('/api/send-approval-email', authenticateToken, async (req, res) => {
    const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    const senderMailbox =
        extractMailbox(process.env.SES_SENDER_EMAIL) ||
        extractMailbox(process.env.SES_FROM_EMAIL) ||
        'notifications@piratefuse.com';
    const agencyNameEnv = process.env.AGENCY_NAME || 'Agency';
    const replyToConfigured = extractMailbox(process.env.AGENCY_REPLY_TO_EMAIL);

    try {
        const { to, clientName, clientId, shareUrl, keywords } = req.body || {};
        if (!to || typeof to !== 'string' || !to.includes('@')) {
            return res.status(400).json({ error: 'Valid recipient email (to) is required' });
        }
        if (!shareUrl || typeof shareUrl !== 'string') {
            return res.status(400).json({ error: 'shareUrl is required' });
        }
        const verifiedShareUrl = safeHttpUrl(shareUrl);
        if (!verifiedShareUrl) {
            return res.status(400).json({ error: 'shareUrl must be an http(s) URL' });
        }
        const list = Array.isArray(keywords) ? keywords : [];

        const subject =
            `[Negative keywords pending approval] ${clientName || clientId || 'Client'} — requested by ${req.user?.email || 'user'}`;

        let textLines = [
            `${req.user?.name || req.user?.email || 'A team member'} sent pending negative keywords for your review.`,
            '',
            `Client: ${clientName || clientId || 'N/A'}${clientId ? ` (ID ${clientId})` : ''}`,
            '',
            'Suggested negatives:',
            ...list.map((k) =>
                `- ${k.keyword || ''} (${k.matchType || 'EXACT'})${k.destination ? ` · ${k.destination}` : ''}${k.campaignName ? ` · ${k.campaignName}` : ''}`
            ),
            list.length === 0 ? '(none listed)' : '',
            '',
            'Open the shared review link (you must sign in):',
            verifiedShareUrl,
            '',
            '— Sent from Google Ads Negative Keyword Tool',
        ].filter(Boolean);

        const rowsHtml = list.length === 0
            ? '<p><em>(No keywords attached.)</em></p>'
            : `<table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e5e7eb;">
                <thead><tr><th>Keyword</th><th>Match</th><th>Destination</th><th>Campaign</th></tr></thead>
                <tbody>${list.map(k => `
                    <tr>
                        <td>${escapeHtml(k.keyword)}</td>
                        <td>${escapeHtml(k.matchType)}</td>
                        <td>${escapeHtml(k.destination)}</td>
                        <td>${escapeHtml(k.campaignName)}</td>
                    </tr>`).join('')}</tbody>
            </table>`;

        const bodyHtml =
            `<p>${escapeHtml(req.user?.name || req.user?.email || 'A teammate')} sent pending negative keywords for approval.</p>
            <p><strong>Client:</strong> ${escapeHtml(clientName || clientId || 'N/A')} ${clientId ? escapeHtml(`(ID ${clientId})`) : ''}</p>
            ${rowsHtml}
            <p style="margin-top:24px"><a href="${escapeAttr(verifiedShareUrl)}"><strong>Open review link</strong></a> (sign-in required).</p>
            <p style="color:#6b7280;font-size:12px">Sent from Google Ads Negative Keyword Tool</p>`;

        const replyTo = replyToConfigured || extractMailbox(req.user?.email) || '';
        const sourceAddr = pirateFuseSesSource(senderMailbox, agencyNameEnv);

        const ses = new SESClient({ region });

        await ses.send(
            new SendEmailCommand({
                Source: sourceAddr,
                Destination: { ToAddresses: [to.trim()] },
                ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
                Message: {
                    Subject: { Data: subject, Charset: 'UTF-8' },
                    Body: {
                        Text: { Data: textLines.join('\n'), Charset: 'UTF-8' },
                        Html: { Data: bodyHtml, Charset: 'UTF-8' },
                    },
                },
            })
        );

        res.json({ success: true, message: `Email sent to ${to.trim()}` });
    } catch (err) {
        console.error('send-approval-email:', err.message || err);
        const detail = err.message || String(err);
        res.status(502).json({
            error: 'Failed to send email via SES',
            details: detail,
        });
    }
});

// ===== Review request flow =====

/** Common SES sender used by review request emails (mirrors send-approval-email config). */
function getReviewEmailContext() {
    const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    const senderMailbox =
        extractMailbox(process.env.SES_SENDER_EMAIL) ||
        extractMailbox(process.env.SES_FROM_EMAIL) ||
        'notifications@piratefuse.com';
    const agencyName = process.env.AGENCY_NAME || 'Agency';
    const replyToConfigured = extractMailbox(process.env.AGENCY_REPLY_TO_EMAIL);
    const sourceAddr = pirateFuseSesSource(senderMailbox, agencyName);
    return { region, sourceAddr, replyToConfigured, agencyName };
}

/** Format YYYY-MM-DD HH:MM in UTC for emails. */
function formatExpiry(d) {
    try {
        return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    } catch {
        return String(d);
    }
}

/** Email the client a public review link; never blocks the flow on SES failure. */
async function sendReviewClientInviteEmail({
    to,
    publicUrl,
    clientName,
    requestedByName,
    requestedByEmail,
    expiresAt,
    items,
    replyTo,
}) {
    const { region, sourceAddr, replyToConfigured } = getReviewEmailContext();
    if (!to || !to.includes('@')) return;
    const fromName = requestedByName || requestedByEmail || 'A team member';
    const subject = `[Negative keyword review] Please review for ${clientName || 'your account'}`;
    const itemList = Array.isArray(items) ? items : [];
    const itemsForText = itemList
        .slice(0, 50)
        .map((it) => `- ${it.keyword} (${it.matchType || 'PHRASE'})`)
        .join('\n');
    const moreLine = itemList.length > 50 ? `…and ${itemList.length - 50} more.` : '';

    const textLines = [
        `${fromName} has put together a list of suggested negative keywords for ${clientName || 'your Google Ads account'} and wants your review before anything is added.`,
        '',
        `Open your review (no login required):`,
        publicUrl,
        '',
        `This link expires on ${formatExpiry(expiresAt)} and can only be submitted once.`,
        '',
        `Suggested negatives (${itemList.length}):`,
        itemsForText || '(none listed)',
        moreLine,
        '',
        '— Sent from Google Ads Negative Keyword Tool',
    ].filter(Boolean);

    const rowsHtml = itemList.length === 0
        ? '<p><em>(No keywords attached.)</em></p>'
        : `<table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e5e7eb;">
            <thead><tr><th>Keyword</th><th>Match</th></tr></thead>
            <tbody>${itemList.slice(0, 50).map(it => `
                <tr>
                    <td>${escapeHtml(it.keyword)}</td>
                    <td>${escapeHtml(it.matchType || 'PHRASE')}</td>
                </tr>`).join('')}${itemList.length > 50
                    ? `<tr><td colspan="2"><em>…and ${itemList.length - 50} more</em></td></tr>`
                    : ''}</tbody>
        </table>`;

    const html =
        `<p>${escapeHtml(fromName)} put together a list of suggested negative keywords for <strong>${escapeHtml(clientName || 'your Google Ads account')}</strong> and is asking for your review before anything is added.</p>
        <p style="margin:24px 0"><a href="${escapeAttr(publicUrl)}" style="background:#1a73e8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open your review</a></p>
        <p style="color:#5f6368;font-size:13px">No login required. This link expires on <strong>${escapeHtml(formatExpiry(expiresAt))}</strong> and can only be submitted once.</p>
        ${rowsHtml}
        <p style="color:#6b7280;font-size:12px;margin-top:24px">Sent from Google Ads Negative Keyword Tool</p>`;

    const ses = new SESClient({ region });
    const replyAddr = replyTo || replyToConfigured || extractMailbox(requestedByEmail) || '';
    await ses.send(new SendEmailCommand({
        Source: sourceAddr,
        Destination: { ToAddresses: [String(to).trim()] },
        ...(replyAddr ? { ReplyToAddresses: [replyAddr] } : {}),
        Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
                Text: { Data: textLines.join('\n'), Charset: 'UTF-8' },
                Html: { Data: html, Charset: 'UTF-8' },
            },
        },
    }));
}

/** Email strategist after a client submits their review. */
async function sendReviewStrategistNotifyEmail({
    to,
    confirmUrl,
    clientName,
    recipientEmail,
    blockCount,
    keepCount,
}) {
    const { region, sourceAddr, replyToConfigured } = getReviewEmailContext();
    if (!to || !to.includes('@')) return;
    const subject = `[Review submitted] ${clientName || 'Client'} reviewed negative keywords`;

    const textLines = [
        `${recipientEmail || 'The client'} just submitted their negative keyword review for ${clientName || 'this account'}.`,
        '',
        `Block: ${blockCount}`,
        `Keep:  ${keepCount}`,
        '',
        'Confirm and finalize submission to Google Ads:',
        confirmUrl,
        '',
        '— Sent from Google Ads Negative Keyword Tool',
    ];

    const html =
        `<p><strong>${escapeHtml(recipientEmail || 'The client')}</strong> just submitted their negative keyword review for <strong>${escapeHtml(clientName || 'this account')}</strong>.</p>
        <p>Block: <strong>${blockCount}</strong> · Keep: <strong>${keepCount}</strong></p>
        <p style="margin:24px 0"><a href="${escapeAttr(confirmUrl)}" style="background:#137333;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Review & finalize submission</a></p>
        <p style="color:#6b7280;font-size:12px">Sent from Google Ads Negative Keyword Tool</p>`;

    const ses = new SESClient({ region });
    await ses.send(new SendEmailCommand({
        Source: sourceAddr,
        Destination: { ToAddresses: [String(to).trim()] },
        ...(replyToConfigured ? { ReplyToAddresses: [replyToConfigured] } : {}),
        Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
                Text: { Data: textLines.join('\n'), Charset: 'UTF-8' },
                Html: { Data: html, Charset: 'UTF-8' },
            },
        },
    }));
}

/**
 * Submit a list of negative keyword items (already filtered to "block") to Google Ads.
 * Mirrors `/api/add-to-exclusion-list`, `/api/add-campaign-negative`,
 * `/api/add-adgroup-negative` so review finalize never diverges from the live flow.
 */
async function submitItemsToGoogleAds(clientId, items) {
    const submitItems = (items || []).filter(i => i && typeof i.keyword === 'string' && i.keyword.trim());
    if (submitItems.length === 0) return { submittedKeywords: [], summaryParts: [] };

    const listKeywords = submitItems.filter(i => (i.destination || 'NEGATIVE_LIST') === 'NEGATIVE_LIST');
    const campaignKeywords = submitItems.filter(i => (i.destination || '') === 'CAMPAIGN');
    const adGroupKeywords = submitItems.filter(i => (i.destination || '') === 'ADGROUP');

    const submittedKeywords = [];
    const summaryParts = [];

    if (listKeywords.length > 0) {
        const byList = {};
        for (const item of listKeywords) {
            const sid = item.sharedSetId;
            if (!sid) {
                const err = new Error(`Item "${item.keyword}" missing sharedSetId for keyword list destination`);
                err.userFacing = true;
                throw err;
            }
            (byList[sid] ||= []).push(item);
        }
        const isNotFoundError = (err) =>
            err.errors?.some(e => e.error_code?.mutate_error === 'RESOURCE_NOT_FOUND');
        await Promise.all(Object.entries(byList).map(async ([sid, items]) => {
            const buildCriteria = (customerId) => items.map(i => ({
                shared_set: `customers/${customerId}/sharedSets/${sid}`,
                keyword: { text: i.keyword, match_type: i.matchType || 'EXACT' }
            }));
            const trySubmit = async (customerId) => {
                const c = client.Customer({
                    customer_id: customerId,
                    login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
                    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
                });
                return c.sharedCriteria.create(buildCriteria(customerId));
            };
            try {
                await withRetry(() => trySubmit(clientId));
            } catch (firstErr) {
                const managerId = process.env.GOOGLE_ADS_MANAGER_ID;
                if (isNotFoundError(firstErr) && managerId && managerId !== clientId) {
                    await withRetry(() => trySubmit(managerId));
                } else {
                    throw firstErr;
                }
            }
        }));
        listKeywords.forEach(item => submittedKeywords.push(item.keyword));
        summaryParts.push(`${listKeywords.length} to keyword list`);
    }

    if (campaignKeywords.length > 0) {
        const byCampaign = {};
        for (const item of campaignKeywords) {
            if (!item.campaignId) {
                const err = new Error(`Item "${item.keyword}" missing campaignId for campaign-level destination`);
                err.userFacing = true;
                throw err;
            }
            (byCampaign[item.campaignId] ||= []).push(item);
        }
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
        });
        await Promise.all(Object.entries(byCampaign).map(async ([campaignId, items]) => {
            const criteria = items.map(item => ({
                campaign: `customers/${clientId}/campaigns/${campaignId}`,
                negative: true,
                keyword: { text: item.keyword, match_type: item.matchType || 'EXACT' },
            }));
            await withRetry(() => customer.campaignCriteria.create(criteria));
        }));
        campaignKeywords.forEach(item => submittedKeywords.push(item.keyword));
        summaryParts.push(`${campaignKeywords.length} at campaign level`);
    }

    if (adGroupKeywords.length > 0) {
        const byAdGroup = {};
        for (const item of adGroupKeywords) {
            if (!item.adGroupId) {
                const err = new Error(`Item "${item.keyword}" missing adGroupId for ad group-level destination`);
                err.userFacing = true;
                throw err;
            }
            (byAdGroup[item.adGroupId] ||= []).push(item);
        }
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
        });
        await Promise.all(Object.entries(byAdGroup).map(async ([adGroupId, items]) => {
            const criteria = items.map(item => ({
                ad_group: `customers/${clientId}/adGroups/${adGroupId}`,
                negative: true,
                keyword: { text: item.keyword, match_type: item.matchType || 'EXACT' },
            }));
            await withRetry(() => customer.adGroupCriteria.create(criteria));
        }));
        adGroupKeywords.forEach(item => submittedKeywords.push(item.keyword));
        summaryParts.push(`${adGroupKeywords.length} at ad group level`);
    }

    return { submittedKeywords, summaryParts };
}

/** Map a review_request_items DB row into the camelCase shape used by submit/finalize logic. */
function mapReviewItemRow(row) {
    return {
        id: row.id,
        keyword: row.keyword,
        matchType: row.match_type || 'PHRASE',
        destination: row.destination || 'NEGATIVE_LIST',
        campaignId: row.campaign_id || null,
        campaignName: row.campaign_name || null,
        adGroupId: row.ad_group_id || null,
        adGroupName: row.ad_group_name || null,
        sharedSetId: row.shared_set_id || null,
        sourceMeta: row.source_meta || null,
    };
}

async function loadReviewRequestForStrategist(id) {
    const { rows: requestRows } = await dbPool.query(
        `SELECT id, client_id, client_name, requested_by_email, requested_by_name, recipient_email,
                status, expires_at, submitted_at, approved_at, created_at, updated_at
         FROM review_requests WHERE id = $1`,
        [id],
    );
    if (requestRows.length === 0) return null;
    const request = requestRows[0];
    const { rows: itemRows } = await dbPool.query(
        `SELECT i.id, i.keyword, i.match_type, i.destination, i.campaign_id, i.campaign_name,
                i.ad_group_id, i.ad_group_name, i.shared_set_id, i.source_meta,
                d.decision
         FROM review_request_items i
         LEFT JOIN review_request_decisions d ON d.review_request_item_id = i.id
         WHERE i.review_request_id = $1
         ORDER BY i.id ASC`,
        [id],
    );
    const items = itemRows.map((row) => ({
        ...mapReviewItemRow(row),
        decision: row.decision || null,
    }));
    return { request, items };
}

/**
 * Strategist creates a review request: persists items, hashes token, optionally emails the client.
 * Returns the publicUrl with the raw token; the raw token is never persisted.
 */
app.post('/api/review-requests', async (req, res) => {
    const {
        clientId,
        clientName,
        recipientEmail,
        items,
        expirationDays,
        sendEmail,
    } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'At least one keyword item is required' });
    }
    const cleanedItems = items
        .filter((it) => it && typeof it.keyword === 'string' && it.keyword.trim())
        .map((it) => ({
            keyword: String(it.keyword || '').trim(),
            matchType: String(it.matchType || 'PHRASE').toUpperCase(),
            destination: ['NEGATIVE_LIST', 'CAMPAIGN', 'ADGROUP'].includes(it.destination)
                ? it.destination
                : 'NEGATIVE_LIST',
            campaignId: it.campaignId != null ? String(it.campaignId) : null,
            campaignName: it.campaignName || null,
            adGroupId: it.adGroupId != null ? String(it.adGroupId) : null,
            adGroupName: it.adGroupName || null,
            sharedSetId: it.sharedSetId != null ? String(it.sharedSetId) : null,
            sourceMeta: it.sourceMeta && typeof it.sourceMeta === 'object' ? it.sourceMeta : null,
        }));
    if (cleanedItems.length === 0) {
        return res.status(400).json({ error: 'No valid keyword items in request' });
    }

    const id = crypto.randomUUID();
    const rawToken = generateReviewToken();
    const tokenHash = hashReviewToken(rawToken);
    const expiryDays = clampExpirationDays(expirationDays);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const dbClient = await dbPool.connect();
    try {
        await dbClient.query('BEGIN');
        await dbClient.query(
            `INSERT INTO review_requests
                (id, token_hash, client_id, client_name, requested_by_email, requested_by_name,
                 recipient_email, status, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
            [
                id,
                tokenHash,
                String(clientId),
                clientName || null,
                req.user?.email || null,
                req.user?.name || null,
                recipientEmail || null,
                REVIEW_STATUSES.PENDING_CLIENT,
                expiresAt,
            ],
        );
        for (const it of cleanedItems) {
            await dbClient.query(
                `INSERT INTO review_request_items
                    (review_request_id, keyword, match_type, destination,
                     campaign_id, campaign_name, ad_group_id, ad_group_name,
                     shared_set_id, source_meta)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    id,
                    it.keyword,
                    it.matchType,
                    it.destination,
                    it.campaignId,
                    it.campaignName,
                    it.adGroupId,
                    it.adGroupName,
                    it.sharedSetId,
                    it.sourceMeta ? JSON.stringify(it.sourceMeta) : null,
                ],
            );
        }
        await dbClient.query('COMMIT');
    } catch (err) {
        await dbClient.query('ROLLBACK').catch(() => {});
        console.error('Error creating review request:', err);
        return res.status(500).json({ error: 'Failed to create review request', details: err.message });
    } finally {
        dbClient.release();
    }

    const baseUrl = buildAppBaseUrl(req);
    const publicUrl = `${baseUrl}/review-public?t=${encodeURIComponent(rawToken)}`;
    const confirmUrl = `${baseUrl}/review-confirm/${id}`;

    let emailWarning = null;
    if (sendEmail !== false && recipientEmail) {
        try {
            await sendReviewClientInviteEmail({
                to: recipientEmail,
                publicUrl,
                clientName,
                requestedByName: req.user?.name,
                requestedByEmail: req.user?.email,
                expiresAt,
                items: cleanedItems,
            });
        } catch (err) {
            console.error('Failed to send client invite email:', err.message || err);
            emailWarning = err.message || 'Failed to send client invite email.';
        }
    }

    res.json({
        success: true,
        id,
        publicUrl,
        confirmUrl,
        expiresAt,
        status: REVIEW_STATUSES.PENDING_CLIENT,
        ...(emailWarning ? { emailWarning } : {}),
    });
});

/** Strategist detail view — never exposes the raw token. */
app.get('/api/review-requests/:id', async (req, res) => {
    try {
        const data = await loadReviewRequestForStrategist(req.params.id);
        if (!data) return res.status(404).json({ error: 'Review request not found' });
        const { request, items } = data;
        res.json({
            id: request.id,
            clientId: request.client_id,
            clientName: request.client_name,
            requestedByEmail: request.requested_by_email,
            requestedByName: request.requested_by_name,
            recipientEmail: request.recipient_email,
            status: request.status,
            expiresAt: request.expires_at,
            submittedAt: request.submitted_at,
            approvedAt: request.approved_at,
            createdAt: request.created_at,
            updatedAt: request.updated_at,
            items,
        });
    } catch (err) {
        console.error('Error loading review request:', err);
        res.status(500).json({ error: 'Failed to load review request', details: err.message });
    }
});

/** Strategist finalizes: submits "block" decisions to Google Ads, marks approved. */
app.post('/api/review-requests/:id/finalize', async (req, res) => {
    const { id } = req.params;
    try {
        const data = await loadReviewRequestForStrategist(id);
        if (!data) return res.status(404).json({ error: 'Review request not found' });
        const { request, items } = data;
        if (request.status !== REVIEW_STATUSES.CLIENT_SUBMITTED) {
            return res.status(409).json({
                error: `Cannot finalize: current status is "${request.status}"`,
            });
        }
        const blockItems = items.filter((it) => it.decision === 'block');
        const summary = await submitItemsToGoogleAds(request.client_id, blockItems);

        const matchTypeLabel = (() => {
            const types = [...new Set(blockItems.map((i) => i.matchType))];
            if (types.length === 1) {
                return ({ EXACT: 'Exact match', PHRASE: 'Phrase match', BROAD: 'Broad match' })[types[0]] || types[0];
            }
            return types.length > 0 ? 'Mixed match types' : '';
        })();
        if (blockItems.length > 0) {
            const allSubmitted = blockItems.map((i) => ({ keyword: i.keyword, matchType: i.matchType }));
            await dbPool.query(
                `INSERT INTO submission_history (client_id, keyword_count, list_name, match_types, keywords, submitted_by_email, submitted_by_name)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    request.client_id,
                    allSubmitted.length,
                    `Review request · ${request.client_name || ''}`.trim(),
                    matchTypeLabel,
                    JSON.stringify(allSubmitted),
                    req.user?.email || null,
                    req.user?.name || '',
                ],
            ).catch((err) => {
                console.error('finalize: history insert failed:', err.message);
            });
        }

        await dbPool.query(
            `UPDATE review_requests
             SET status = $1, approved_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND status = $3`,
            [REVIEW_STATUSES.APPROVED_BY_STRATEGIST, id, REVIEW_STATUSES.CLIENT_SUBMITTED],
        );

        res.json({
            success: true,
            blockCount: blockItems.length,
            keepCount: items.length - blockItems.length,
            summary: summary.summaryParts.join(' · '),
        });
    } catch (err) {
        console.error('finalize error:', err);
        const friendly = err.userFacing
            ? err.message
            : err.message?.includes('CONCURRENT') || err.isFriendly
                ? 'Google Ads is temporarily busy — try again in a moment.'
                : err.message || 'Finalize failed';
        res.status(500).json({ error: 'Failed to finalize review request', details: friendly });
    }
});

/** Strategist rejects (doesn't push anything to Google). */
app.post('/api/review-requests/:id/reject', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await dbPool.query(
            `UPDATE review_requests
             SET status = $1, updated_at = NOW()
             WHERE id = $2
               AND status IN ($3, $4)
             RETURNING id, status`,
            [
                REVIEW_STATUSES.REJECTED_BY_STRATEGIST,
                id,
                REVIEW_STATUSES.CLIENT_SUBMITTED,
                REVIEW_STATUSES.PENDING_CLIENT,
            ],
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ error: 'Review request cannot be rejected from its current status' });
        }
        res.json({ success: true, status: result.rows[0].status });
    } catch (err) {
        console.error('reject error:', err);
        res.status(500).json({ error: 'Failed to reject review request', details: err.message });
    }
});

/** Strategist cancels a still-pending request before the client submits. */
app.post('/api/review-requests/:id/cancel', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await dbPool.query(
            `UPDATE review_requests
             SET status = $1, updated_at = NOW()
             WHERE id = $2 AND status = $3
             RETURNING id, status`,
            [REVIEW_STATUSES.CANCELLED, id, REVIEW_STATUSES.PENDING_CLIENT],
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ error: 'Review request is not pending' });
        }
        res.json({ success: true, status: result.rows[0].status });
    } catch (err) {
        console.error('cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel review request', details: err.message });
    }
});

// ===== Public review endpoints (no authentication) =====

/** Lightweight in-memory rate limiter for public review endpoints. */
const PUBLIC_REVIEW_RATE_LIMIT = new Map();
function publicReviewRateLimit(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
    const key = `${ip}:${req.method}`;
    const now = Date.now();
    const WINDOW_MS = 60 * 1000;
    const MAX = req.method === 'POST' ? 20 : 120;
    const entry = PUBLIC_REVIEW_RATE_LIMIT.get(key) || { count: 0, resetAt: now + WINDOW_MS };
    if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + WINDOW_MS;
    }
    entry.count++;
    PUBLIC_REVIEW_RATE_LIMIT.set(key, entry);
    if (entry.count > MAX) {
        return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    next();
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of PUBLIC_REVIEW_RATE_LIMIT) {
        if (v.resetAt < now - 5 * 60 * 1000) PUBLIC_REVIEW_RATE_LIMIT.delete(k);
    }
}, 5 * 60 * 1000).unref?.();

/** Public client view: returns the review request + items for a valid token. */
app.get('/api/public/review', publicReviewRateLimit, async (req, res) => {
    const token = (req.query?.token || '').toString().trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const tokenHash = hashReviewToken(token);
    try {
        const { rows: reqRows } = await dbPool.query(
            `SELECT id, client_id, client_name, requested_by_email, requested_by_name,
                    status, expires_at, submitted_at
             FROM review_requests WHERE token_hash = $1`,
            [tokenHash],
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Review link is invalid or has been removed.' });
        const request = reqRows[0];
        const isExpired = new Date(request.expires_at).getTime() <= Date.now();
        const effectiveStatus = (request.status === REVIEW_STATUSES.PENDING_CLIENT && isExpired)
            ? REVIEW_STATUSES.EXPIRED
            : request.status;
        const { rows: itemRows } = await dbPool.query(
            `SELECT id, keyword, match_type, destination, campaign_id, campaign_name,
                    ad_group_id, ad_group_name, shared_set_id, source_meta
             FROM review_request_items
             WHERE review_request_id = $1
             ORDER BY id ASC`,
            [request.id],
        );
        res.json({
            id: request.id,
            clientName: request.client_name,
            requestedByEmail: request.requested_by_email,
            requestedByName: request.requested_by_name,
            status: effectiveStatus,
            expiresAt: request.expires_at,
            submittedAt: request.submitted_at,
            items: itemRows.map(mapReviewItemRow),
        });
    } catch (err) {
        console.error('public review GET error:', err);
        res.status(500).json({ error: 'Failed to load review', details: err.message });
    }
});

/**
 * Public client submit: atomic transition pending_client -> client_submitted.
 * Decisions are validated against item IDs that belong to the same request.
 */
app.post('/api/public/review/submit', publicReviewRateLimit, async (req, res) => {
    const token = (req.body?.token || '').toString().trim();
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!token) return res.status(400).json({ error: 'Missing token' });
    if (decisions.length === 0) return res.status(400).json({ error: 'At least one decision is required' });
    const tokenHash = hashReviewToken(token);

    const dbClient = await dbPool.connect();
    try {
        await dbClient.query('BEGIN');
        // Atomic transition guards against double-submit and expired tokens
        const updateResult = await dbClient.query(
            `UPDATE review_requests
             SET status = $1, submitted_at = NOW(), updated_at = NOW()
             WHERE token_hash = $2
               AND status = $3
               AND expires_at > NOW()
             RETURNING id, client_id, client_name, requested_by_email, recipient_email`,
            [REVIEW_STATUSES.CLIENT_SUBMITTED, tokenHash, REVIEW_STATUSES.PENDING_CLIENT],
        );
        if (updateResult.rows.length === 0) {
            await dbClient.query('ROLLBACK');
            const peek = await dbPool.query(
                'SELECT status, expires_at FROM review_requests WHERE token_hash = $1',
                [tokenHash],
            );
            if (peek.rows.length === 0) {
                return res.status(404).json({ error: 'Review link is invalid.' });
            }
            const row = peek.rows[0];
            const expired = new Date(row.expires_at).getTime() <= Date.now();
            return res.status(409).json({
                error: expired
                    ? 'This review link has expired. Ask your strategist for a new link.'
                    : 'This review has already been submitted.',
                status: expired && row.status === REVIEW_STATUSES.PENDING_CLIENT
                    ? REVIEW_STATUSES.EXPIRED
                    : row.status,
            });
        }
        const request = updateResult.rows[0];

        const itemIdsResult = await dbClient.query(
            'SELECT id FROM review_request_items WHERE review_request_id = $1',
            [request.id],
        );
        const validIds = new Set(itemIdsResult.rows.map((r) => Number(r.id)));
        let blockCount = 0;
        let keepCount = 0;
        for (const d of decisions) {
            const itemId = Number(d?.itemId);
            const decision = String(d?.decision || '').toLowerCase();
            if (!validIds.has(itemId)) continue;
            if (!REVIEW_DECISIONS.has(decision)) continue;
            await dbClient.query(
                `INSERT INTO review_request_decisions (review_request_item_id, decision, decided_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (review_request_item_id) DO UPDATE
                   SET decision = EXCLUDED.decision, decided_at = EXCLUDED.decided_at`,
                [itemId, decision],
            );
            if (decision === 'block') blockCount++;
            else keepCount++;
        }
        await dbClient.query('COMMIT');

        const baseUrl = buildAppBaseUrl(req);
        const confirmUrl = `${baseUrl}/review-confirm/${request.id}`;
        if (request.requested_by_email) {
            sendReviewStrategistNotifyEmail({
                to: request.requested_by_email,
                confirmUrl,
                clientName: request.client_name,
                recipientEmail: request.recipient_email,
                blockCount,
                keepCount,
            }).catch((err) => {
                console.error('Failed to send strategist notify email:', err.message || err);
            });
        }
        res.json({ success: true, blockCount, keepCount });
    } catch (err) {
        await dbClient.query('ROLLBACK').catch(() => {});
        console.error('public review submit error:', err);
        res.status(500).json({ error: 'Failed to submit review', details: err.message });
    } finally {
        dbClient.release();
    }
});

/** Hourly sweeper: marks pending_client requests past their expires_at as expired. */
async function sweepExpiredReviewRequests() {
    try {
        const r = await dbPool.query(
            `UPDATE review_requests
             SET status = $1, updated_at = NOW()
             WHERE status = $2 AND expires_at < NOW()`,
            [REVIEW_STATUSES.EXPIRED, REVIEW_STATUSES.PENDING_CLIENT],
        );
        if (r.rowCount > 0) {
            console.log(`[review-sweeper] marked ${r.rowCount} review requests expired`);
        }
    } catch (err) {
        console.error('[review-sweeper] failed:', err.message);
    }
}
setInterval(sweepExpiredReviewRequests, 60 * 60 * 1000).unref?.();
setTimeout(sweepExpiredReviewRequests, 30 * 1000).unref?.();

// New endpoint to get list of clients
app.get('/api/clients', async (req, res) => {
    try {
        // Use manager account to get list of clients
        const managerCustomer = client.Customer({
            customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        const clientsQuery = `
            SELECT 
                customer_client.id,
                customer_client.descriptive_name,
                customer_client.status
            FROM customer_client
            WHERE customer_client.status = 'ENABLED'
            ORDER BY customer_client.descriptive_name ASC
        `;

        const response = await managerCustomer.query(clientsQuery);
        
        const clients = response.map(row => ({
            customerId: row.customer_client.id,
            descriptiveName: row.customer_client.descriptive_name,
            status: row.customer_client.status
        }));

        res.json(clients);
    } catch (error) {
        console.error('Error fetching clients:', error.message);
        console.error('Error code:', error.code);
        console.error('Error details:', JSON.stringify(error.errors || error.response?.data || error, null, 2));
        res.status(500).json({
            error: 'Failed to fetch clients',
            details: error.message,
            code: error.code,
            errors: error.errors || error.response?.data
        });
    }
});

// Modified endpoint to handle client selection
app.get('/api/search-terms', async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) {
            return res.status(400).json({ error: 'Client ID is required' });
        }

        // Default date range: previous calendar month
        const today = new Date();
        const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastOfPrevMonth = new Date(firstOfThisMonth - 1);
        const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);

        const endDate = req.query.endDate || lastOfPrevMonth.toISOString().split('T')[0];
        const startDate = req.query.startDate || firstOfPrevMonth.toISOString().split('T')[0];

       

        // Initialize customer with selected client ID
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        // Query for search terms - back to clicks > 0 filter
        const searchTermQuery = `
            SELECT 
                search_term_view.search_term,
                segments.keyword.info.text,
                segments.keyword.info.match_type,
                metrics.clicks,
                metrics.impressions,
                metrics.cost_micros,
                metrics.conversions,
                metrics.ctr,
                metrics.average_cpc,
                campaign.id,
                campaign.name,
                ad_group.id,
                ad_group.name
            FROM search_term_view
            WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
                AND metrics.clicks > 0
            ORDER BY metrics.clicks DESC
            LIMIT 5000
        `;

        const searchTermResponse = await customer.query(searchTermQuery);
        let emptyReason = null;
        if (searchTermResponse.length === 0) {
            const anyTermsQuery = `
                SELECT search_term_view.search_term
                FROM search_term_view
                WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
                    AND metrics.impressions > 0
                LIMIT 1
            `;
            const anyTermsResponse = await customer.query(anyTermsQuery);
            emptyReason = anyTermsResponse.length > 0 ? 'no_clicks_only' : 'no_data';
        }
        // Log totals to compare with UI
        const totalClicks = searchTermResponse.reduce((sum, row) => sum + (row.metrics.clicks || 0), 0);
        const totalImpressions = searchTermResponse.reduce((sum, row) => sum + (row.metrics.impressions || 0), 0);
        console.log(
            `API returned: ${searchTermResponse.length} rows | ${totalClicks} clicks | ${totalImpressions} impressions${emptyReason ? ` | emptyReason=${emptyReason}` : ''}`
        );


        // Transform the data - simple mapping like original
        const transformedData = searchTermResponse.map(row => ({
            searchTerm: row.search_term_view.search_term,
            campaignId: String(row.campaign.id),
            campaign: row.campaign.name,
            adGroupId: String(row.ad_group.id),
            adGroup: row.ad_group.name,
            clicks: row.metrics.clicks,
            impressions: row.metrics.impressions,
            ctr: row.metrics.ctr,
            averageCpc: row.metrics.average_cpc,
            cost: row.metrics.cost_micros / 1000000,
            conversions: row.metrics.conversions,
            costPerConversion: row.metrics.conversions > 0 
                ? (row.metrics.cost_micros / 1000000) / row.metrics.conversions 
                : 0,
            conversionRate: row.metrics.conversions > 0 
                ? (row.metrics.conversions / row.metrics.clicks) * 100 
                : 0,
            matchingKeyword: row.segments?.keyword?.info?.text || '',
            matchType: row.segments?.keyword?.info?.match_type || ''
        }));

        res.json({
            searchTerms: transformedData,
            emptyReason
        });
    } catch (error) {
        console.error('Error details:', error);
        res.status(500).json({
            error: 'Failed to fetch data',
            details: error.message
        });
    }
});

app.get('/api/negative-keywords', async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) {
            return res.status(400).json({ error: 'Client ID is required' });
        }

        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        // Fetch from four sources: shared sets, campaign-level, ad group-level,
        // and the campaign↔shared_set attachment map (so we know which campaigns
        // a list actually applies to).
        const queries = [
            // 1. Shared set negative keywords (negative keyword lists)
            `SELECT 
                shared_criterion.resource_name,
                shared_criterion.keyword.text,
                shared_criterion.keyword.match_type,
                shared_set.id,
                shared_set.name,
                shared_set.status,
                shared_set.type,
                shared_set.member_count
            FROM shared_criterion
            WHERE 
                shared_set.type = NEGATIVE_KEYWORDS 
                AND shared_set.status = ENABLED`,
            
            // 2. Campaign-level negative keywords
            `SELECT 
                campaign_criterion.resource_name,
                campaign_criterion.keyword.text,
                campaign_criterion.keyword.match_type,
                campaign.name,
                campaign.id
            FROM campaign_criterion
            WHERE 
                campaign_criterion.negative = true
                AND campaign_criterion.status = ENABLED`,
            
            // 3. Ad group-level negative keywords  
            `SELECT 
                ad_group_criterion.resource_name,
                ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group.name,
                ad_group.id,
                campaign.name,
                campaign.id
            FROM ad_group_criterion
            WHERE 
                ad_group_criterion.negative = true
                AND ad_group_criterion.status = ENABLED`,

            // 4. Shared set attachments — which campaigns each list applies to
            `SELECT
                campaign.id,
                shared_set.id
            FROM campaign_shared_set`
        ];

        const labels = ['shared_criterion', 'campaign_criterion', 'ad_group_criterion', 'campaign_shared_set'];
        const [sharedResponse, campaignResponse, adGroupResponse, sharedSetAttachments] = await Promise.all(
            queries.map((query, i) => {
                const label = labels[i];
                return customer.query(query).catch((e) => {
                    console.error(`[negative-keywords] ${label} query failed:`, e.message, JSON.stringify(e.errors || null));
                    return [];
                });
            })
        );

        // Map: sharedSetId -> [campaignIds the list is attached to]
        const appliedCampaignIdsBySet = new Map();
        sharedSetAttachments.forEach(row => {
            const setId = row.shared_set?.id != null ? String(row.shared_set.id) : '';
            const campId = row.campaign?.id != null ? String(row.campaign.id) : '';
            if (!setId || !campId) return;
            if (!appliedCampaignIdsBySet.has(setId)) appliedCampaignIdsBySet.set(setId, []);
            appliedCampaignIdsBySet.get(setId).push(campId);
        });
        
        const allNegatives = [];

        // Process shared set keywords
        sharedResponse
            .filter(row => row.shared_criterion?.keyword?.text)
            .forEach(row => {
                const numericMatchType = row.shared_criterion.keyword.match_type;
                let matchType = 'EXACT';
                if (numericMatchType === 2) matchType = 'EXACT';
                else if (numericMatchType === 3) matchType = 'PHRASE'; 
                else if (numericMatchType === 4) matchType = 'BROAD';
                else if (typeof numericMatchType === 'string') matchType = numericMatchType;

                const sharedSetId = row.shared_set?.id != null ? String(row.shared_set.id) : '';
                allNegatives.push({
                    keyword: row.shared_criterion.keyword.text,
                    matchType: matchType,
                    source: 'SHARED_SET',
                    location: row.shared_set.name,
                    resourceName: row.shared_criterion.resource_name,
                    sharedSetId,
                    appliedCampaignIds: appliedCampaignIdsBySet.get(sharedSetId) || [],
                });
            });

        // Process campaign-level keywords
        campaignResponse
            .filter(row => row.campaign_criterion?.keyword?.text)
            .forEach(row => {
                const numericMatchType = row.campaign_criterion.keyword.match_type;
                let matchType = 'EXACT';
                if (numericMatchType === 2) matchType = 'EXACT';
                else if (numericMatchType === 3) matchType = 'PHRASE'; 
                else if (numericMatchType === 4) matchType = 'BROAD';
                else if (typeof numericMatchType === 'string') matchType = numericMatchType;
                
                allNegatives.push({
                    keyword: row.campaign_criterion.keyword.text,
                    matchType: matchType,
                    source: 'CAMPAIGN',
                    location: row.campaign.name,
                    resourceName: row.campaign_criterion.resource_name,
                    campaignId: row.campaign?.id != null ? String(row.campaign.id) : '',
                });
            });

        // Process ad group-level keywords
        adGroupResponse
            .filter(row => row.ad_group_criterion?.keyword?.text)
            .forEach(row => {
                const numericMatchType = row.ad_group_criterion.keyword.match_type;
                let matchType = 'EXACT';
                if (numericMatchType === 2) matchType = 'EXACT';
                else if (numericMatchType === 3) matchType = 'PHRASE'; 
                else if (numericMatchType === 4) matchType = 'BROAD';
                else if (typeof numericMatchType === 'string') matchType = numericMatchType;
                
                allNegatives.push({
                    keyword: row.ad_group_criterion.keyword.text,
                    matchType: matchType,
                    source: 'AD_GROUP',
                    location: `${row.campaign.name} › ${row.ad_group.name}`,
                    resourceName: row.ad_group_criterion.resource_name,
                    campaignId: row.campaign?.id != null ? String(row.campaign.id) : '',
                    adGroupId: row.ad_group?.id != null ? String(row.ad_group.id) : '',
                });
            });

        console.log(`Fetched ${allNegatives.length} total negatives: ${sharedResponse.length} shared, ${campaignResponse.length} campaign, ${adGroupResponse.length} ad group; ${sharedSetAttachments.length} shared-set attachments`);

        // Debug: Log sample keywords from each source
        if (sharedResponse.length > 0) {
            console.log('Sample shared set keywords:', sharedResponse.slice(0, 3).map(r => r.shared_criterion?.keyword?.text));
        }
        if (campaignResponse.length > 0) {
            console.log('Sample campaign keywords:', campaignResponse.slice(0, 3).map(r => r.campaign_criterion?.keyword?.text));
            console.log('From campaigns:', campaignResponse.slice(0, 3).map(r => r.campaign?.name));
        }
        if (adGroupResponse.length > 0) {
            console.log('Sample ad group keywords:', adGroupResponse.slice(0, 3).map(r => r.ad_group_criterion?.keyword?.text));
            console.log('From ad groups:', adGroupResponse.slice(0, 3).map(r => `${r.campaign?.name} › ${r.ad_group?.name}`));
        }

        const transformedData = { 
            "Global Negative Keywords": allNegatives
        };

        res.json(transformedData);
    } catch (error) {
        console.error('Error fetching negative keywords:', error);
        res.status(500).json({
            error: 'Failed to fetch negative keywords',
            details: error.message
        });
    }
});

app.get('/api/shared-sets', async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        const sharedSetFields = `
                shared_set.id,
                shared_set.name,
                shared_set.resource_name,
                shared_set.member_count,
                shared_set.status`;
        const whereClause = `
                shared_set.type = NEGATIVE_KEYWORDS
                AND shared_set.status = ENABLED`;

        // Query client lists AND manager's own lists in parallel so we can exclude
        // any list that exists in the manager account (user cannot write to those)
        const managerCustomer = client.Customer({
            customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        const [ownedResponse, managerResponse] = await Promise.all([
            customer.query(`SELECT ${sharedSetFields} FROM shared_set WHERE ${whereClause}`),
            managerCustomer.query(`SELECT shared_set.id FROM shared_set WHERE ${whereClause}`).catch(() => [])
        ]);

        // Build a set of IDs that belong to the manager account
        const managerSetIds = new Set(managerResponse.map(r => String(r.shared_set.id)));
        console.log('[shared-sets] manager set IDs:', [...managerSetIds]);

        const seen = new Set();
        const sharedSets = ownedResponse
            .filter(row => {
                const id = String(row.shared_set.id);
                if (seen.has(id)) return false;
                seen.add(id);
                // Exclude any list that also exists in the manager account
                return !managerSetIds.has(id);
            })
            .map(row => ({
                id: String(row.shared_set.id),
                name: row.shared_set.name,
                memberCount: row.shared_set.member_count,
                resourceName: row.shared_set.resource_name
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        res.json(sharedSets);
    } catch (error) {
        console.error('Error fetching shared sets:', error);
        res.status(500).json({ error: 'Failed to fetch shared sets', details: error.message });
    }
});

app.post('/api/create-shared-set', async (req, res) => {
    const { clientId, name } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'List name is required' });

    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        const response = await customer.sharedSets.create([{
            name: name.trim(),
            type: 'NEGATIVE_KEYWORDS',
        }]);

        const resourceName = response.results?.[0]?.resource_name || response[0]?.resource_name;
        if (!resourceName) throw new Error('No resource name returned from Google Ads');

        const id = resourceName.split('/').pop();

        console.log(`Created shared set: ${name.trim()} (id: ${id}) for client ${clientId}`);
        res.json({
            success: true,
            sharedSet: { id: String(id), name: name.trim(), resourceName, memberCount: 0 }
        });
    } catch (err) {
        console.error('Error creating shared set:', err.message);
        const details = err.errors?.[0]?.message || err.message || 'Unknown error';
        res.status(500).json({ error: 'Failed to create shared set', details });
    }
});

app.post('/api/add-to-exclusion-list', async (req, res) => {
    const { negativeKeywords, sharedSetId, clientId } = req.body;

    try {
        if (!clientId) throw new Error('Client ID is required');
        if (!sharedSetId) throw new Error('Shared set ID is required');
        if (!negativeKeywords || !negativeKeywords.length) throw new Error('No negative keywords provided');

        // Build criteria objects — shared_set resource name uses the given customer ID
        const buildCriteria = (customerId) => negativeKeywords.map(item => {
            const text = typeof item === 'string' ? item : item.keyword;
            const matchType = typeof item === 'string' ? 'EXACT' : (item.matchType || 'EXACT');
            return {
                shared_set: `customers/${customerId}/sharedSets/${sharedSetId}`,
                keyword: { text, match_type: matchType }
            };
        });

        const trySubmit = async (customerId) => {
            const c = client.Customer({
                customer_id: customerId,
                login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
                refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
            });
            return c.sharedCriteria.create(buildCriteria(customerId));
        };

        const isNotFoundError = (err) =>
            err.errors?.some(e => e.error_code?.mutate_error === 'RESOURCE_NOT_FOUND');

        let response;
        let usedCustomerId = clientId;

        try {
            // First attempt: use the client account
            console.log(`Attempt 1: submitting via client account ${clientId}`);
            response = await withRetry(() => trySubmit(clientId));
        } catch (firstErr) {
            const managerId = process.env.GOOGLE_ADS_MANAGER_ID;
            if (isNotFoundError(firstErr) && managerId && managerId !== clientId) {
                // The list is likely owned by the manager account — retry with manager
                console.log(`Client attempt failed (RESOURCE_NOT_FOUND). Retrying via manager account ${managerId}`);
                response = await withRetry(() => trySubmit(managerId));
                usedCustomerId = managerId;
            } else {
                throw firstErr;
            }
        }

        console.log(`Success: submitted via customer ${usedCustomerId}`);
        res.json({ success: true, response, details: { sharedSetId, negativeKeywords, usedCustomerId } });

    } catch (error) {
        console.error('Error adding negative keywords to shared set:');
        console.error('  message:', error.message);
        console.error('  errors:', JSON.stringify(error.errors || {}, null, 2));
        const details = error.errors?.[0]?.message || error.message || 'Unknown error';
        res.status(500).json({
            error: 'Failed to add negative keywords to shared set',
            details,
            requestData: { sharedSetId, clientId, keywordCount: negativeKeywords?.length }
        });
    }
});

// Keywords that suggest a page is relevant to understanding the business
const ABOUT_PAGE_KEYWORDS = ['about', 'about-us', 'our-story', 'our-team', 'who-we-are', 'company'];

/** Bounded wait for Bedrock so a hung model call cannot wedge the Express worker indefinitely. */
function abortAfterMs(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

const SCRAPER_BOT_UA = 'Mozilla/5.0 (compatible; GoogleAdsBot/1.0)';
const SCRAPER_BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Sites like CDNs/WAF often return 403 to non-browser UA; retry with Chrome-like headers and log status/errors. */
async function fetchPage(url, timeoutMs = 9000, logFailures = false) {
    let lastDiag = '';

    const tryOnce = async (userAgent, label) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': userAgent,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                signal: controller.signal,
                redirect: 'follow',
            });
            if (!response.ok) {
                lastDiag = `HTTP ${response.status} (${label})`;
                return null;
            }
            return await response.text();
        } catch (e) {
            lastDiag = `${e.name === 'AbortError' ? 'timeout' : e.message || e} (${label})`;
            return null;
        } finally {
            clearTimeout(timer);
        }
    };

    let html = await tryOnce(SCRAPER_BOT_UA, 'bot');
    if (html) return { html, diagnostic: null };

    html = await tryOnce(SCRAPER_BROWSER_UA, 'browser');
    if (html) return { html, diagnostic: null };

    const diagnostic = lastDiag || 'unknown error';
    if (logFailures) {
        console.log(`[Scraper] Fetch failed ${url} — ${diagnostic}`);
    }
    return { html: null, diagnostic };
}

function extractPageContent($, maxBodyChars = 800) {
    $('script, style, noscript, nav, footer, header').remove();
    return {
        h1s: $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 4),
        h2s: $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 6),
        bodyText: $('body').text().replace(/\s+/g, ' ').trim().slice(0, maxBodyChars)
    };
}

function pickRelevantLinks($, baseUrl, limit = 1) {
    const base = new URL(baseUrl);
    const seen = new Set();
    const picked = [];

    $('a[href]').each((_, el) => {
        if (picked.length >= limit) return;
        try {
            const href = $(el).attr('href');
            const resolved = new URL(href, base);
            // Same domain only, no anchors/query strings
            if (resolved.hostname !== base.hostname) return;
            const clean = resolved.origin + resolved.pathname.replace(/\/$/, '');
            if (clean === base.origin + base.pathname.replace(/\/$/, '')) return;
            if (seen.has(clean)) return;
            const pathLower = resolved.pathname.toLowerCase();
            // Only allow "About" style pages so crawl scope stays small and predictable.
            if (ABOUT_PAGE_KEYWORDS.some(kw => pathLower.includes(kw))) {
                seen.add(clean);
                picked.push(clean);
            }
        } catch {}
    });

    return picked;
}

/**
 * @returns {{ scraped: object | null, homepageDiagnostic: string | null }}
 */
async function scrapeWebsiteContext(url) {
    console.log(`[Scraper] Starting scrape for: ${url}`);
    try {
        const homeFetch = await fetchPage(url, 9000, true);
        if (!homeFetch.html) {
            console.log(
                `[Scraper] Homepage not readable (blocked, TLS, robots, timeout, etc.). Continuing AI with URL only: ${url}`,
            );
            return {
                scraped: null,
                homepageDiagnostic: homeFetch.diagnostic || 'Could not load homepage (bad URL, 404/403, or blocked).',
            };
        }

        const $home = cheerio.load(homeFetch.html);
        const title = $home('title').text().trim();
        const metaDesc = $home('meta[name="description"]').attr('content') || '';
        const homeContent = extractPageContent($home, 1000);

        // Fetch homepage + at most one About page.
        const relevantLinks = pickRelevantLinks($home, url, 1);
        console.log(`[Scraper] Homepage: ${url}`);
        console.log(`[Scraper] Relevant pages found: ${relevantLinks.length > 0 ? relevantLinks.join(', ') : 'none'}`);
        const extraPages = await Promise.all(
            relevantLinks.map(async link => {
                const res = await fetchPage(link, 9000, true);
                if (!res.html) { console.log(`[Scraper] Skipping unreadable linked page: ${link}`); return null; }
                console.log(`[Scraper] Fetched: ${link}`);
                const $ = cheerio.load(res.html);
                const content = extractPageContent($, 600);
                return { url: link, ...content };
            })
        );

        return {
            scraped: {
                title: $home('title').text().trim(),
                metaDesc,
                pages: [
                    { url, ...homeContent },
                    ...extraPages.filter(Boolean)
                ],
            },
            homepageDiagnostic: null,
        };
    } catch (err) {
        console.log(`[Scraper] Error scraping ${url}:`, err.message);
        return {
            scraped: null,
            homepageDiagnostic: err.message || 'Unexpected error while reading the site.',
        };
    }
}

app.post('/api/ai-recommend-negatives', async (req, res) => {
    try {
        const { searchTerms, websiteUrl } = req.body;

        if (!searchTerms || !searchTerms.length) {
            return res.status(400).json({ error: 'Search terms are required' });
        }

        const searchTermsTable = searchTerms
            .map((st, i) =>
                `${i + 1}. ${st.searchTerm} | Clicks: ${st.clicks} | Conversions: ${st.conversions} | Campaign: ${st.campaign}`
            )
            .join('\n');

        // Scrape website for richer context (cap wait so unreachable sites never block AI too long)
        let websiteContext = `Website URL: ${websiteUrl || 'Not provided'}`;
        const websiteUrlTrim = typeof websiteUrl === 'string' ? websiteUrl.trim() : '';
        let websiteContextStatus = websiteUrlTrim ? 'unreadable' : 'no_url';
        let websiteFetchDetail = websiteUrlTrim
            ? 'We could not load this URL. Save a working homepage URL before scanning.'
            : null;

        if (websiteUrlTrim) {
            const trimUrl = websiteUrlTrim;
            const scrapeTimeoutMs = 42000;
            const timedOutPayload = Object.freeze({
                scraped: null,
                homepageDiagnostic: `Site scan timed out after ${scrapeTimeoutMs / 1000}s (server very slow or blocking).`,
            });
            const { scraped, homepageDiagnostic } = await Promise.race([
                scrapeWebsiteContext(trimUrl),
                new Promise((resolve) => setTimeout(() => resolve(timedOutPayload), scrapeTimeoutMs)),
            ]);

            if (scraped) {
                websiteContextStatus = 'ok';
                websiteFetchDetail = null;
                const pagesText = scraped.pages.map(p => {
                    const lines = [`[Page: ${p.url}]`];
                    if (p.h1s.length) lines.push(`H1: ${p.h1s.join(' | ')}`);
                    if (p.h2s.length) lines.push(`H2: ${p.h2s.join(' | ')}`);
                    if (p.bodyText) lines.push(`Content: ${p.bodyText}`);
                    return lines.join('\n');
                }).join('\n\n');

                websiteContext = `Website URL: ${trimUrl}
Page Title: ${scraped.title}
Meta Description: ${scraped.metaDesc}

Scanned Pages (${scraped.pages.length}):
${pagesText}`;
            } else {
                websiteContextStatus = 'unreadable';
                websiteFetchDetail =
                    homepageDiagnostic ||
                    'We could not load this URL (bad link, empty page, 404/403, SSL, firewall, etc.). Save a working homepage URL, then scan again.';
            }
        }

        if (websiteUrlTrim && websiteContextStatus === 'unreadable') {
            const totalSt = searchTerms.length;
            return res.json({
                negativeKeywords: [],
                negativeKeywordSources: {},
                summary: {
                    totalSearchTerms: totalSt,
                    negativeCount: 0,
                    qualityPercentage: 100,
                },
                explanation: '',
                websiteContextStatus: 'unreadable',
                websiteFetchDetail,
                scanSkippedDueToBadWebsiteUrl: true,
            });
        }

        const uniqueWords = [
            ...new Set([
                // Individual words
                ...searchTerms.flatMap(st => st.searchTerm.toLowerCase().split(/\s+/)),
                // Full search term phrases (so AI can return multi-word negatives)
                ...searchTerms.map(st => st.searchTerm.toLowerCase()),
            ])
        ].join(', ');

        const prompt = `You are a Google Ads specialist helping identify negative keywords to add to a campaign.

Your job is to find words or phrases that signal a search is NOT from a potential customer of this business. Prefer precision over recall: when intent is ambiguous, do NOT include the term as a negative (avoid costing real leads).

BEFORE YOU BEGIN — SCAN THE WEBSITE:
Before evaluating any search terms, read the provided website content to understand:
- Every product and service this business offers
- What geographic area(s) they serve, if any
- Use this as the foundation for every decision below

RULES:
1. GEOGRAPHIC TERMS: If the business serves a specific local or regional area, add out-of-area location words as negatives. Extract only the location word, not the full phrase. If the business serves nationally or the area is unclear, skip geographic terms.
2. NEVER add the business's own core industry terms as negatives (themes and role words that describe what paying customers actually search for to find this firm — analogous to \"marketing\"/\"agency\" for a marketer). If the site offers that service or audience, omit.
3. NEVER add generic descriptors as negatives inside your returned strings — not even inside a multi-word suggestion (e.g. never output a keyword that contains the phrase \"near me\", \"best \", \"top \", standalone \"cheap\", standalone \"reviews\", standalone \"firm\", standalone \"services\", standalone \"company\", standalone \"local\"). Extract the real offending signal (competitor, wrong city, job-seeking token, unrelated niche token) instead, or omit.
4. DATA ONLY: Every keyword you return MUST be a word or phrase that appears verbatim in the search terms list below. Do NOT invent negatives.
5. Flag words that clearly signal wrong intent: competitor brand names, unrelated industries, job-seeking (\"careers\", \"jobs\", \"hiring\"), DIY/free intent (\"free\", \"template\", \"diy\") when unrelated, or irrelevant proper nouns — not mainstream ways of asking for services the website clearly provides.
6. EXTRACTION RULE — always extract the smallest offending unit. Almost NEVER paste an entire multi-word search query back as one negative phrase (that destroys good traffic unless the ENTIRE query is verbatim a competitor or an unrelated tangent). Strip down to competitor brand, wrong geo token, franchise, salaries, unrelated product, etc.
   - Competitor name in a phrase → extract only the competitor name
   - Out-of-area location in a phrase → extract only the location word
   - Examples:
     - \"mobile fuel delivery franchise\" → \"franchise\"
     - \"John Ford Plumbing Company\" → \"John Ford\"
     - \"best Chicago plumber near me\" (local Columbus business) → \"Chicago\" (do not negate \"near me\" or generic praise words)
7. COMPETITORS: Identify competitor brand names in the search terms using your industry knowledge and add them as negatives (smallest unmistakable substring that appears verbatim in the query).
8. When in doubt, leave it OUT of negativeKeywords entirely.

${websiteContext}

Search Terms (format: term | clicks | conversions | campaign):
${searchTermsTable}

Every unique word present across all search terms (your negatives MUST come only from this set):
${uniqueWords}

FINAL CHECK before writing JSON:
- Does each keyword appear word-for-word in the search terms list? If NO, remove it.
- Is this suggestion literally the FULL text of some search-query line without a disqualifier (jobs, unrelated trade, competitor, wrong city, etc.)? If YES, remove it — shorten to smallest offending substring or omit.

Respond ONLY with a valid JSON object in this exact format, with no additional text before or after:
{
  "negativeKeywords": ["keyword1", "keyword2"],
  "summary": {
    "totalSearchTerms": 0,
    "negativeCount": 0,
    "qualityPercentage": 0
  },
  "explanation": "Brief summary of your analysis. If one keyword (in the 'triggered by keyword' column) is responsible for generating 30% or more of the total recommended negative keywords, explicitly call it out in this explanation and recommend tightening its match type."
}`;

        const command = new InvokeModelCommand({
            modelId: process.env.BEDROCK_CHAT_MODEL,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const bedrockResponse = await bedrockClient.send(command, { abortSignal: abortAfterMs(120000) });
        const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
        const text = responseBody.content[0].text.trim();

        const jsonText = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (_parseErr) {
            const extracted = extractFirstJsonObject(jsonText) || extractFirstJsonObject(text);
            if (!extracted) throw _parseErr;
            parsed = JSON.parse(extracted);
        }

        // Hard filter: remove any keyword the AI invented that isn't present in the actual search terms
        const sourcesMap = {};
        parsed.negativeKeywords = (parsed.negativeKeywords || []).filter(kw => {
            const kwLower = kw.toLowerCase().trim();
            const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
            const matches = searchTerms.filter(st => re.test(st.searchTerm.toLowerCase())).map(st => st.searchTerm);
            sourcesMap[kw] = matches;
            return matches.length > 0;
        });
        parsed.negativeKeywords = parsed.negativeKeywords.filter(
            kw => !shouldDropAiNegativeSuggestion(kw, searchTerms)
        );
        for (const k of Object.keys(sourcesMap)) {
            if (!parsed.negativeKeywords.includes(k)) delete sourcesMap[k];
        }
        parsed.negativeKeywordSources = sourcesMap;

        // Recalculate summary counts based on validated keywords
        if (parsed.summary) {
            parsed.summary.negativeCount = parsed.negativeKeywords.length;
            parsed.summary.qualityPercentage = parsed.summary.totalSearchTerms > 0
                ? Math.round(((parsed.summary.totalSearchTerms - parsed.negativeKeywords.length) / parsed.summary.totalSearchTerms) * 100)
                : 100;
        }

        parsed.websiteContextStatus = websiteContextStatus;
        parsed.websiteFetchDetail = websiteFetchDetail;

        res.json(parsed);
    } catch (error) {
        console.error('Error calling Bedrock:', error);
        const aborted =
            error.name === 'AbortError' ||
            /abort/i.test(String(error.message || '')) ||
            /timeout/i.test(String(error.message || ''));
        const details = aborted
            ? 'Bedrock analysis timed out. The site scrape may have been slow; try again or use a lighter homepage URL.'
            : error.message;
        res.status(500).json({
            error: 'Failed to get AI recommendations',
            details,
        });
    }
});

// Auto-detect website URL from the client's ads
app.get('/api/detect-website', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        const response = await customer.query(`
            SELECT ad_group_ad.ad.final_urls
            FROM ad_group_ad
            WHERE ad_group_ad.status = 'ENABLED'
            LIMIT 20
        `);

        // Collect all final URLs, extract base domains, pick most common one
        const domainCount = {};
        for (const row of response) {
            const urls = row.ad_group_ad?.ad?.final_urls || [];
            for (const url of urls) {
                try {
                    const { origin } = new URL(url);
                    domainCount[origin] = (domainCount[origin] || 0) + 1;
                } catch {}
            }
        }

        const detected = Object.entries(domainCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        res.json({ websiteUrl: detected });
    } catch (error) {
        console.error('Error detecting website:', error.message);
        res.json({ websiteUrl: null });
    }
});

// Get saved website URL and negative keywords for a client
app.get('/api/client-settings', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

    try {
        const [urlResult, negResult, defaultListResult] = await Promise.all([
            dbPool.query('SELECT website_url FROM client_website_urls WHERE client_id = $1', [clientId]),
            dbPool.query('SELECT keyword FROM client_saved_negatives WHERE client_id = $1 ORDER BY created_at ASC', [clientId]),
            dbPool.query('SELECT shared_set_id FROM client_default_shared_sets WHERE client_id = $1', [clientId]),
        ]);

        res.json({
            websiteUrl: urlResult.rows[0]?.website_url || '',
            savedNegatives: negResult.rows.map(r => r.keyword),
            defaultSharedSetId: defaultListResult.rows[0]?.shared_set_id || null,
        });
    } catch (err) {
        console.error('Error fetching client settings:', err);
        res.status(500).json({ error: 'Failed to fetch client settings', details: err.message });
    }
});

// Save or update website URL for a client
app.post('/api/client-website-url', async (req, res) => {
    const { clientId, websiteUrl } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!websiteUrl) return res.status(400).json({ error: 'Website URL is required' });

    try {
        await dbPool.query(`
            INSERT INTO client_website_urls (client_id, website_url, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (client_id) DO UPDATE SET website_url = $2, updated_at = NOW()
        `, [clientId, websiteUrl]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving website URL:', err);
        res.status(500).json({ error: 'Failed to save website URL', details: err.message });
    }
});

// Save or clear the default negative keyword list for a client
app.post('/api/client-default-shared-set', async (req, res) => {
    const { clientId, sharedSetId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    try {
        await dbPool.query(`
            INSERT INTO client_default_shared_sets (client_id, shared_set_id, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (client_id) DO UPDATE SET shared_set_id = $2, updated_at = NOW()
        `, [clientId, sharedSetId || null]);
        res.json({ success: true, defaultSharedSetId: sharedSetId || null });
    } catch (err) {
        console.error('Error saving default shared set:', err);
        res.status(500).json({ error: 'Failed to save default shared set', details: err.message });
    }
});

// Save negative keywords to DB for a client
app.post('/api/client-saved-negatives', async (req, res) => {
    const { clientId, keywords } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!keywords || !keywords.length) return res.status(400).json({ error: 'Keywords are required' });

    try {
        const values = keywords.map((kw, i) => `($1, $${i + 2})`).join(', ');
        await dbPool.query(
            `INSERT INTO client_saved_negatives (client_id, keyword) VALUES ${values} ON CONFLICT DO NOTHING`,
            [clientId, ...keywords]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving negative keywords:', err);
        res.status(500).json({ error: 'Failed to save negative keywords', details: err.message });
    }
});

// Delete a saved negative keyword from DB
app.delete('/api/client-saved-negatives', async (req, res) => {
    const { clientId, keyword } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

    try {
        await dbPool.query(
            'DELETE FROM client_saved_negatives WHERE client_id = $1 AND keyword = $2',
            [clientId, keyword]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting negative keyword:', err);
        res.status(500).json({ error: 'Failed to delete negative keyword', details: err.message });
    }
});

// Load saved pending state for a client
app.get('/api/pending-state', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    try {
        const result = await dbPool.query(
            'SELECT keyword, match_type, destination, shared_set_id, source, selected, campaign_id, campaign_name, ad_group_id, ad_group_name FROM client_pending_state WHERE client_id = $1 ORDER BY saved_at ASC',
            [clientId]
        );
        const items = result.rows.map(r => ({
            keyword: r.keyword,
            matchType: r.match_type,
            destination: r.destination,
            sharedSetId: r.shared_set_id,
            source: r.source,
            selected: r.selected,
            campaignId: r.campaign_id,
            campaignName: r.campaign_name,
            adGroupId: r.ad_group_id,
            adGroupName: r.ad_group_name,
        }));
        res.json(items);
    } catch (err) {
        console.error('Error loading pending state:', err);
        res.status(500).json({ error: 'Failed to load pending state', details: err.message });
    }
});

// Save (replace) pending state for a client
app.post('/api/pending-state', async (req, res) => {
    const { clientId, items } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    try {
        await dbPool.query('DELETE FROM client_pending_state WHERE client_id = $1', [clientId]);
        if (items.length > 0) {
            const values = items.map((_, i) => `($1, $${i * 10 + 2}, $${i * 10 + 3}, $${i * 10 + 4}, $${i * 10 + 5}, $${i * 10 + 6}, $${i * 10 + 7}, $${i * 10 + 8}, $${i * 10 + 9}, $${i * 10 + 10}, $${i * 10 + 11})`).join(', ');
            const params = [clientId, ...items.flatMap(it => {
                const mt = String(it.matchType || 'PHRASE').trim().toUpperCase() || 'PHRASE';
                return [
                    it.keyword,
                    mt,
                    it.destination || 'NEGATIVE_LIST',
                    it.sharedSetId != null ? String(it.sharedSetId) : null,
                    it.source || 'manual',
                    it.selected !== false,
                    it.campaignId != null ? String(it.campaignId) : null,
                    it.campaignName || null,
                    it.adGroupId != null ? String(it.adGroupId) : null,
                    it.adGroupName || null,
                ];
            })];
            await dbPool.query(
                `INSERT INTO client_pending_state (client_id, keyword, match_type, destination, shared_set_id, source, selected, campaign_id, campaign_name, ad_group_id, ad_group_name) VALUES ${values}`,
                params
            );
        }
        res.json({ success: true, saved: items.length });
    } catch (err) {
        console.error('Error saving pending state:', err);
        res.status(500).json({ error: 'Failed to save pending state', details: err.message });
    }
});

// Clear saved pending state for a client
app.delete('/api/pending-state', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    try {
        await dbPool.query('DELETE FROM client_pending_state WHERE client_id = $1', [clientId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error clearing pending state:', err);
        res.status(500).json({ error: 'Failed to clear pending state', details: err.message });
    }
});

// Save a submission record
app.post('/api/submission-history', authenticateToken, async (req, res) => {
    const { clientId, keywords, listName, matchTypes } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!keywords || !keywords.length) return res.status(400).json({ error: 'Keywords are required' });

    try {
        await dbPool.query(
            `INSERT INTO submission_history (client_id, keyword_count, list_name, match_types, keywords, submitted_by_email, submitted_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                clientId, 
                keywords.length, 
                listName || '', 
                matchTypes || '', 
                JSON.stringify(keywords),
                req.user.email,
                req.user.name || ''
            ]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving submission history:', err);
        res.status(500).json({ error: 'Failed to save submission history', details: err.message });
    }
});

// Get submission history for a client
app.get('/api/submission-history', authenticateToken, async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

    try {
        const result = await dbPool.query(
            `SELECT id, submitted_at, keyword_count, list_name, match_types, keywords, submitted_by_email, submitted_by_name
             FROM submission_history
             WHERE client_id = $1
             ORDER BY submitted_at DESC
             LIMIT 50`,
            [clientId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching submission history:', err);
        res.status(500).json({ error: 'Failed to fetch submission history', details: err.message });
    }
});

// ── Campaigns ─────────────────────────────────────────────────────────────────
app.get('/api/campaigns', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });
        const rows = await customer.query(`
            SELECT campaign.id, campaign.name, campaign.resource_name, campaign.status
            FROM campaign
            WHERE campaign.status != REMOVED
            ORDER BY campaign.name
        `);
        res.json(rows.map(row => ({
            id: String(row.campaign.id),
            name: row.campaign.name,
            resourceName: row.campaign.resource_name,
            status: row.campaign.status,
        })));
    } catch (err) {
        console.error('Error fetching campaigns:', err.message);
        res.status(500).json({ error: 'Failed to fetch campaigns', details: err.message });
    }
});

// ── Ad Groups ─────────────────────────────────────────────────────────────────
app.get('/api/adgroups', async (req, res) => {
    const { clientId, campaignId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });
    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });
        const rows = await customer.query(`
            SELECT ad_group.id, ad_group.name, ad_group.resource_name, ad_group.status
            FROM ad_group
            WHERE campaign.id = '${campaignId}'
            AND ad_group.status != REMOVED
            ORDER BY ad_group.name
        `);
        res.json(rows.map(row => ({
            id: String(row.ad_group.id),
            name: row.ad_group.name,
            resourceName: row.ad_group.resource_name,
            status: row.ad_group.status,
        })));
    } catch (err) {
        console.error('Error fetching ad groups:', err.message);
        res.status(500).json({ error: 'Failed to fetch ad groups', details: err.message });
    }
});

// ── Campaign-level negative keywords ──────────────────────────────────────────
app.post('/api/add-campaign-negative', async (req, res) => {
    const { negativeKeywords, campaignId, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });
    if (!negativeKeywords || !negativeKeywords.length) return res.status(400).json({ error: 'No keywords provided' });
    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });
        const criteria = negativeKeywords.map(item => ({
            campaign: `customers/${clientId}/campaigns/${campaignId}`,
            negative: true,
            keyword: {
                text: typeof item === 'string' ? item : item.keyword,
                match_type: typeof item === 'string' ? 'EXACT' : (item.matchType || 'EXACT'),
            },
        }));
        const response = await withRetry(() => customer.campaignCriteria.create(criteria));
        console.log(`Campaign-level negatives submitted: ${negativeKeywords.length} keywords to campaign ${campaignId}`);
        res.json({ success: true, response });
    } catch (err) {
        console.error('Error adding campaign-level negatives:', err.errors || err.message);
        const details = err.errors?.[0]?.message || err.message || 'Unknown error';
        res.status(500).json({ error: 'Failed to add campaign-level negative keywords', details });
    }
});

// ── Ad group-level negative keywords ──────────────────────────────────────────
app.post('/api/add-adgroup-negative', async (req, res) => {
    const { negativeKeywords, adGroupId, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    if (!adGroupId) return res.status(400).json({ error: 'Ad group ID required' });
    if (!negativeKeywords || !negativeKeywords.length) return res.status(400).json({ error: 'No keywords provided' });
    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });
        const criteria = negativeKeywords.map(item => ({
            ad_group: `customers/${clientId}/adGroups/${adGroupId}`,
            negative: true,
            keyword: {
                text: typeof item === 'string' ? item : item.keyword,
                match_type: typeof item === 'string' ? 'EXACT' : (item.matchType || 'EXACT'),
            },
        }));
        const response = await withRetry(() => customer.adGroupCriteria.create(criteria));
        console.log(`Ad group-level negatives submitted: ${negativeKeywords.length} keywords to ad group ${adGroupId}`);
        res.json({ success: true, response });
    } catch (err) {
        console.error('Error adding ad group-level negatives:', err.errors || err.message);
        const details = err.errors?.[0]?.message || err.message || 'Unknown error';
        res.status(500).json({ error: 'Failed to add ad group-level negative keywords', details });
    }
});

// Remove a negative keyword from Google Ads (campaign, ad group, or shared set)
app.delete('/api/remove-google-negative', async (req, res) => {
    const { resourceName, source, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    if (!resourceName) return res.status(400).json({ error: 'Resource name required' });
    if (!source) return res.status(400).json({ error: 'Source required' });
    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });
        if (source === 'CAMPAIGN') {
            await withRetry(() => customer.campaignCriteria.remove([resourceName]));
        } else if (source === 'AD_GROUP') {
            await withRetry(() => customer.adGroupCriteria.remove([resourceName]));
        } else if (source === 'SHARED_SET') {
            await withRetry(() => customer.sharedCriteria.remove([resourceName]));
        } else {
            return res.status(400).json({ error: `Unknown source type: ${source}` });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error removing Google negative:', err.errors || err.message);
        const details = err.errors?.[0]?.message || err.message || 'Unknown error';
        res.status(500).json({ error: 'Failed to remove negative keyword', details });
    }
});

// Apply negative keyword list to campaigns
app.post('/api/apply-list-to-campaigns', async (req, res) => {
    const { sharedSetId, campaignIds, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!sharedSetId) return res.status(400).json({ error: 'Shared set ID is required' });
    if (!campaignIds || !campaignIds.length) return res.status(400).json({ error: 'Campaign IDs are required' });

    try {
        const customer = client.Customer({
            customer_id: clientId,
            login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        // Create campaign shared set associations
        const associations = campaignIds.map(campaignId => ({
            campaign: `customers/${clientId}/campaigns/${campaignId}`,
            shared_set: `customers/${clientId}/sharedSets/${sharedSetId}`,
            status: 'ENABLED'
        }));

        const response = await withRetry(() => customer.campaignSharedSets.create(associations));
        
        console.log(`Applied shared set ${sharedSetId} to ${campaignIds.length} campaigns for client ${clientId}`);
        res.json({ 
            success: true, 
            response,
            appliedTo: campaignIds.length,
            sharedSetId,
            campaignIds 
        });
    } catch (err) {
        console.error('Error applying shared set to campaigns:', err.errors || err.message);
        const details = err.errors?.[0]?.message || err.message || 'Unknown error';
        res.status(500).json({ 
            error: 'Failed to apply negative keyword list to campaigns', 
            details,
            sharedSetId,
            campaignIds 
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        clientInitialized: !!client
    });
});

// Add diagnostic endpoint to check API access level
app.get('/api/debug/access-level', async (req, res) => {
    try {
        const managerCustomer = client.Customer({
            customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
            refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN
        });

        // Try to get account info which should work with any access level
        const accountInfo = await managerCustomer.query(`
            SELECT customer.id, customer.descriptive_name, customer.manager
            FROM customer
        `);

        // Check what APIs we can access by testing different operations
        const accessTests = {
            canReadCustomers: false,
            canReadCampaigns: false,
            canReadSharedSets: false,
            canCreateSharedSet: false,
            canCreateCampaignCriteria: false,
            errorDetails: {}
        };

        try {
            await managerCustomer.query('SELECT customer.id FROM customer LIMIT 1');
            accessTests.canReadCustomers = true;
        } catch (err) {
            accessTests.errorDetails.readCustomers = err.message;
        }

        try {
            await managerCustomer.query('SELECT campaign.id FROM campaign LIMIT 1');
            accessTests.canReadCampaigns = true;
        } catch (err) {
            accessTests.errorDetails.readCampaigns = err.message;
        }

        try {
            await managerCustomer.query('SELECT shared_set.id FROM shared_set LIMIT 1');
            accessTests.canReadSharedSets = true;
        } catch (err) {
            accessTests.errorDetails.readSharedSets = err.message;
        }

        res.json({
            managerAccountId: process.env.GOOGLE_ADS_MANAGER_ID,
            accountInfo: accountInfo[0],
            accessTests,
            interpretation: {
                likelyAccessLevel: accessTests.canCreateSharedSet ? 'STANDARD' : 'BASIC',
                explanation: 'Standard access allows full CRUD operations, Basic access is mostly read-only with limited write permissions'
            }
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to check access level',
            details: error.message,
            errors: error.errors
        });
    }
});

// Fallback to React app for client-side routing
app.get('*', (req, res) => {
  // Skip API routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});