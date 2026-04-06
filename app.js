require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { GoogleAdsApi } = require('google-ads-api');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const cheerio = require('cheerio');

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
            CREATE TABLE IF NOT EXISTS submission_history (
                id SERIAL PRIMARY KEY,
                client_id VARCHAR(30) NOT NULL,
                submitted_at TIMESTAMP DEFAULT NOW(),
                keyword_count INTEGER NOT NULL,
                list_name TEXT,
                match_types TEXT,
                keywords JSONB NOT NULL
            )
        `);
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
            const isConcurrent =
                err.errors?.some(e =>
                    e.error_code?.mutate_error === 'CONCURRENT_MODIFICATION' ||
                    /concurrent/i.test(e.message || '')
                ) || /concurrent/i.test(err.message || '');

            if (isConcurrent && attempt < maxAttempts) {
                console.log(`[retry] CONCURRENT_MODIFICATION on attempt ${attempt}, retrying in ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                throw err;
            }
        }
    }
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
        // Log totals to compare with UI
        const totalClicks = searchTermResponse.reduce((sum, row) => sum + (row.metrics.clicks || 0), 0);
        const totalImpressions = searchTermResponse.reduce((sum, row) => sum + (row.metrics.impressions || 0), 0);
        console.log(`API returned: ${searchTermResponse.length} rows | ${totalClicks} clicks | ${totalImpressions} impressions`);


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

        res.json(transformedData);
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

        // Fetch from all three sources: shared sets, campaign-level, and ad group-level
        const queries = [
            // 1. Shared set negative keywords (negative keyword lists)
            `SELECT 
                shared_criterion.keyword.text,
                shared_criterion.keyword.match_type,
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
                ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group.name,
                ad_group.id,
                campaign.name,
                campaign.id
            FROM ad_group_criterion
            WHERE 
                ad_group_criterion.negative = true
                AND ad_group_criterion.status = ENABLED`
        ];

        const [sharedResponse, campaignResponse, adGroupResponse] = await Promise.all(
            queries.map(query => customer.query(query).catch(() => []))
        );
        
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
                
                allNegatives.push({
                    keyword: row.shared_criterion.keyword.text,
                    matchType: matchType,
                    source: 'SHARED_SET',
                    location: row.shared_set.name
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
                    location: row.campaign.name
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
                    location: `${row.campaign.name} › ${row.ad_group.name}`
                });
            });

        console.log(`Fetched ${allNegatives.length} total negatives: ${sharedResponse.length} shared, ${campaignResponse.length} campaign, ${adGroupResponse.length} ad group`);

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
const RELEVANT_PAGE_KEYWORDS = ['service', 'product', 'about', 'treatment', 'solution', 'offer', 'specialty', 'what-we-do', 'what_we_do', 'care', 'practice', 'work'];

async function fetchPage(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoogleAdsBot/1.0)' },
            signal: controller.signal
        });
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function extractPageContent($, maxBodyChars = 800) {
    $('script, style, noscript, nav, footer, header').remove();
    return {
        h1s: $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 4),
        h2s: $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 6),
        bodyText: $('body').text().replace(/\s+/g, ' ').trim().slice(0, maxBodyChars)
    };
}

function pickRelevantLinks($, baseUrl, limit = 4) {
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
            if (RELEVANT_PAGE_KEYWORDS.some(kw => pathLower.includes(kw))) {
                seen.add(clean);
                picked.push(clean);
            }
        } catch {}
    });

    return picked;
}

async function scrapeWebsiteContext(url) {
    console.log(`[Scraper] Starting scrape for: ${url}`);
    try {
        const homepageHtml = await fetchPage(url);
        if (!homepageHtml) { console.log(`[Scraper] Failed to fetch homepage: ${url}`); return null; }

        const $home = cheerio.load(homepageHtml);
        const title = $home('title').text().trim();
        const metaDesc = $home('meta[name="description"]').attr('content') || '';
        const homeContent = extractPageContent($home, 1000);

        // Find and fetch up to 4 relevant internal pages
        const relevantLinks = pickRelevantLinks($home, url, 4);
        console.log(`[Scraper] Homepage: ${url}`);
        console.log(`[Scraper] Relevant pages found: ${relevantLinks.length > 0 ? relevantLinks.join(', ') : 'none'}`);
        const extraPages = await Promise.all(
            relevantLinks.map(async link => {
                const html = await fetchPage(link);
                if (!html) { console.log(`[Scraper] Failed to fetch: ${link}`); return null; }
                console.log(`[Scraper] Fetched: ${link}`);
                const $ = cheerio.load(html);
                const content = extractPageContent($, 600);
                return { url: link, ...content };
            })
        );

        return {
            title: $home('title').text().trim(),
            metaDesc,
            pages: [
                { url, ...homeContent },
                ...extraPages.filter(Boolean)
            ]
        };
    } catch (err) {
        console.log(`[Scraper] Error scraping ${url}:`, err.message);
        return null;
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

        // Scrape website for richer context
        let websiteContext = `Website URL: ${websiteUrl || 'Not provided'}`;
        if (websiteUrl) {
            const scraped = await scrapeWebsiteContext(websiteUrl);
            if (scraped) {
                const pagesText = scraped.pages.map(p => {
                    const lines = [`[Page: ${p.url}]`];
                    if (p.h1s.length) lines.push(`H1: ${p.h1s.join(' | ')}`);
                    if (p.h2s.length) lines.push(`H2: ${p.h2s.join(' | ')}`);
                    if (p.bodyText) lines.push(`Content: ${p.bodyText}`);
                    return lines.join('\n');
                }).join('\n\n');

                websiteContext = `Website URL: ${websiteUrl}
Page Title: ${scraped.title}
Meta Description: ${scraped.metaDesc}

Scanned Pages (${scraped.pages.length}):
${pagesText}`;
            }
        }

        const uniqueWords = [...new Set(
            searchTerms.flatMap(st => st.searchTerm.toLowerCase().split(/\s+/))
        )].join(', ');

        const prompt = `You are a Google Ads specialist helping identify negative keywords to add to a campaign.

Your job is to find words or phrases that signal a search is NOT from a potential customer of this business. Be thorough — it is better to catch more negatives than to miss them.

BEFORE YOU BEGIN — SCAN THE WEBSITE:
Before evaluating any search terms, read the provided website content to understand:
- Every product and service this business offers
- What geographic area(s) they serve, if any
- Use this as the foundation for every decision below

RULES:
1. GEOGRAPHIC TERMS: If the business serves a specific local or regional area, add out-of-area location words as negatives. Extract only the location word, not the full phrase. If the business serves nationally or the area is unclear, skip geographic terms.
2. NEVER add the business's own core industry terms as negatives (e.g. for a marketing agency: "marketing", "agency", "digital", "seo", "advertising").
3. NEVER add generic descriptor words like "company", "firm", "services", "best", "top", "near me", "local".
4. DATA ONLY: Every keyword you return MUST be a word or phrase that appears verbatim in the search terms list below. Do NOT invent negatives.
5. Flag words that clearly signal wrong intent: competitor brand names, unrelated industries, job-seeking ("careers", "jobs", "hiring"), DIY/free intent ("free", "template", "diy"), or irrelevant proper nouns.
6. EXTRACTION RULE — always extract the smallest offending unit:
   - Competitor name in a phrase → extract only the competitor name
   - Out-of-area location in a phrase → extract only the location word
   - Examples:
     - "mobile fuel delivery franchise" → "franchise"
     - "John Ford Plumbing Company" → "John Ford"
     - "best Chicago plumber near me" (local Columbus business) → "Chicago"
7. COMPETITORS: Identify all competitor brand names in the search terms using your industry knowledge and add them as negatives.
8. Be reasonably confident a word is irrelevant — you don't need to be 100% certain. If it's probably wrong intent, include it.

${websiteContext}

Search Terms (format: term | clicks | conversions | campaign):
${searchTermsTable}

Every unique word present across all search terms (your negatives MUST come only from this set):
${uniqueWords}

FINAL CHECK before writing JSON:
- Does each keyword appear word-for-word in the search terms list? If NO, remove it.
- Is it the smallest unit (not a full phrase when one word is the problem)? If NO, trim it.

Respond ONLY with a valid JSON object in this exact format, with no additional text before or after:
{
  "negativeKeywords": ["keyword1", "keyword2"],
  "summary": {
    "totalSearchTerms": 0,
    "negativeCount": 0,
    "qualityPercentage": 0
  },
  "explanation": "Brief summary of your analysis"
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

        const bedrockResponse = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
        const text = responseBody.content[0].text.trim();

        const jsonText = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(jsonText);

        // Hard filter: remove any keyword the AI invented that isn't present in the actual search terms
        const searchTermsLower = searchTerms.map(st => st.searchTerm.toLowerCase());
        parsed.negativeKeywords = (parsed.negativeKeywords || []).filter(kw => {
            const kwLower = kw.toLowerCase().trim();
            const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
            return searchTermsLower.some(term => re.test(term));
        });

        // Recalculate summary counts based on validated keywords
        if (parsed.summary) {
            parsed.summary.negativeCount = parsed.negativeKeywords.length;
            parsed.summary.qualityPercentage = parsed.summary.totalSearchTerms > 0
                ? Math.round(((parsed.summary.totalSearchTerms - parsed.negativeKeywords.length) / parsed.summary.totalSearchTerms) * 100)
                : 100;
        }

        res.json(parsed);
    } catch (error) {
        console.error('Error calling Bedrock:', error);
        res.status(500).json({
            error: 'Failed to get AI recommendations',
            details: error.message
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
        const [urlResult, negResult] = await Promise.all([
            dbPool.query('SELECT website_url FROM client_website_urls WHERE client_id = $1', [clientId]),
            dbPool.query('SELECT keyword FROM client_saved_negatives WHERE client_id = $1 ORDER BY created_at ASC', [clientId])
        ]);

        res.json({
            websiteUrl: urlResult.rows[0]?.website_url || '',
            savedNegatives: negResult.rows.map(r => r.keyword)
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

// Save a submission record
app.post('/api/submission-history', async (req, res) => {
    const { clientId, keywords, listName, matchTypes } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!keywords || !keywords.length) return res.status(400).json({ error: 'Keywords are required' });

    try {
        await dbPool.query(
            `INSERT INTO submission_history (client_id, keyword_count, list_name, match_types, keywords)
             VALUES ($1, $2, $3, $4, $5)`,
            [clientId, keywords.length, listName || '', matchTypes || '', JSON.stringify(keywords)]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving submission history:', err);
        res.status(500).json({ error: 'Failed to save submission history', details: err.message });
    }
});

// Get submission history for a client
app.get('/api/submission-history', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

    try {
        const result = await dbPool.query(
            `SELECT id, submitted_at, keyword_count, list_name, match_types, keywords
             FROM submission_history
             WHERE client_id = $1
             ORDER BY submitted_at DESC
             LIMIT 30`,
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