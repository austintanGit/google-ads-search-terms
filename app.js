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

        // Query for search terms
        const searchTermQuery = `
            SELECT 
                search_term_view.search_term,
                metrics.clicks,
                metrics.impressions,
                metrics.cost_micros,
                metrics.conversions,
                metrics.ctr,
                metrics.average_cpc,
                campaign.name,
                ad_group.name,
                ad_group.id
            FROM search_term_view
            WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            ORDER BY metrics.clicks DESC
            LIMIT 100
        `;

        const searchTermResponse = await customer.query(searchTermQuery);

        // Transform the data
        const transformedData = searchTermResponse.map(row => ({
            searchTerm: row.search_term_view.search_term,
            campaign: row.campaign.name,
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

        const negativeKeywordsQuery = `
            SELECT 
                shared_criterion.keyword.text,
                shared_set.name,
                shared_set.status,
                shared_set.type,
                shared_set.member_count
            FROM shared_criterion
            WHERE 
                shared_set.type = NEGATIVE_KEYWORDS 
                AND shared_set.status = ENABLED
        `;

        const response = await customer.query(negativeKeywordsQuery);
        
        const negativeKeywords = response.map(row => 
            row.shared_criterion?.keyword?.text || ''
        ).filter(keyword => keyword !== '');

        const transformedData = { 
            "Global Negative Keywords": negativeKeywords
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

        // Query 1: client-owned lists (regardless of campaign linkage)
        // Query 2: lists applied to campaigns (catches manager-owned lists)
        const [ownedResponse, campaignResponse] = await Promise.all([
            customer.query(`SELECT ${sharedSetFields} FROM shared_set WHERE ${whereClause}`),
            customer.query(`SELECT ${sharedSetFields} FROM campaign_shared_set WHERE ${whereClause}`)
        ]);

        // Merge and deduplicate by shared_set.id
        const seen = new Set();
        const sharedSets = [...ownedResponse, ...campaignResponse]
            .filter(row => {
                const id = String(row.shared_set.id);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
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
            response = await trySubmit(clientId);
        } catch (firstErr) {
            const managerId = process.env.GOOGLE_ADS_MANAGER_ID;
            if (isNotFoundError(firstErr) && managerId && managerId !== clientId) {
                // The list is likely owned by the manager account — retry with manager
                console.log(`Client attempt failed (RESOURCE_NOT_FOUND). Retrying via manager account ${managerId}`);
                response = await trySubmit(managerId);
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

        const prompt = `You are a Google Ads specialist helping identify negative keywords to add to a campaign.

Your ONLY job is to find words that signal a search is clearly NOT from a potential customer of this business. You will return a SHORT list of specific negative keywords — typically 5–15 words or phrases, never more than 20.

ABSOLUTE RULES (violating any of these is a critical error):
1. NEVER add geographic terms (city names, state names, country names, regions) as negatives — ever.
2. NEVER add the business's own industry terms as negatives (e.g. for a marketing agency: "marketing", "agency", "digital", "seo", "advertising", "branding", "media").
3. NEVER add generic descriptor words like "company", "firm", "services", "best", "top", "near me", "local" — these are valuable qualifiers, not negatives.
4. ONLY recommend a keyword if it actually appears in one or more of the search terms listed above. Do NOT invent keywords based on general logic — every keyword you return must be a word or phrase found in the data.
5. ONLY flag a word if it clearly signals a completely different intent — e.g. a competitor's brand name, an unrelated industry, job-seeking intent, or DIY/free intent.
6. When a search term contains a competitor name alongside valid words, ONLY extract the competitor name — not the other words.
7. If you are not 100% sure a word is irrelevant, leave it out.
8. Aim for a quality percentage above 70%. If your negativeCount exceeds 15% of total terms, you are being too aggressive — reduce the list.

${websiteContext}

Search Terms (format: term | clicks | conversions | campaign):
${searchTermsTable}

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

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        clientInitialized: !!client
    });
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