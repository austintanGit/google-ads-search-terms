const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const cheerio = require('cheerio');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const ABOUT_PAGE_KEYWORDS = ['about', 'about-us', 'our-story', 'our-team', 'who-we-are', 'company'];
const SCRAPER_BOT_UA = 'Mozilla/5.0 (compatible; GoogleAdsBot/1.0)';
const SCRAPER_BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function resolveAiBatchSize() {
    const raw = parseInt(process.env.AI_BATCH_SIZE || '50', 10);
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 50;
}

function abortAfterMs(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

function normalizeSearchQueryForAi(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function shouldDropAiNegativeSuggestion(keyword, searchTerms) {
    const t = typeof keyword === 'string' ? keyword.trim() : '';
    if (!t) return true;
    const low = t.toLowerCase();
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

function parseAiRecommendationJson(rawText) {
    const text = String(rawText || '').trim();
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        return JSON.parse(jsonText);
    } catch (parseErr) {
        const extracted = extractFirstJsonObject(jsonText) || extractFirstJsonObject(text);
        if (!extracted) throw parseErr;
        return JSON.parse(extracted);
    }
}

async function invokeBedrockChat(messages, abortSignal) {
    const command = new InvokeModelCommand({
        modelId: process.env.BEDROCK_CHAT_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 4096,
            messages,
        }),
    });
    const bedrockResponse = await bedrockClient.send(command, { abortSignal });
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    return responseBody.content?.[0]?.text?.trim() ?? '';
}

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

    let html = await tryOnce(SCRAPER_BROWSER_UA, 'browser');
    if (html) return { html, diagnostic: null };

    html = await tryOnce(SCRAPER_BOT_UA, 'bot');
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
        bodyText: $('body').text().replace(/\s+/g, ' ').trim().slice(0, maxBodyChars),
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
            if (resolved.hostname !== base.hostname) return;
            const clean = resolved.origin + resolved.pathname.replace(/\/$/, '');
            if (clean === base.origin + base.pathname.replace(/\/$/, '')) return;
            if (seen.has(clean)) return;
            const pathLower = resolved.pathname.toLowerCase();
            if (ABOUT_PAGE_KEYWORDS.some((kw) => pathLower.includes(kw))) {
                seen.add(clean);
                picked.push(clean);
            }
        } catch {
            /* skip invalid href */
        }
    });

    return picked;
}

async function scrapeWebsiteContext(url) {
    console.log(`[Scraper] Starting scrape for: ${url}`);
    try {
        const homeFetch = await fetchPage(url, 9000, true);
        if (!homeFetch.html) {
            console.log(
                `[Scraper] Homepage not readable (blocked, TLS, robots, timeout, etc.). Continuing with search terms only: ${url}`,
            );
            return {
                scraped: null,
                homepageDiagnostic: homeFetch.diagnostic || 'Could not load homepage (bad URL, 404/403, or blocked).',
            };
        }

        const $home = cheerio.load(homeFetch.html);
        const homeContent = extractPageContent($home, 1000);
        const relevantLinks = pickRelevantLinks($home, url, 1);
        const extraPages = await Promise.all(
            relevantLinks.map(async (link) => {
                const res = await fetchPage(link, 9000, true);
                if (!res.html) return null;
                const $ = cheerio.load(res.html);
                return { url: link, ...extractPageContent($, 600) };
            }),
        );

        return {
            scraped: {
                title: $home('title').text().trim(),
                metaDesc: $home('meta[name="description"]').attr('content') || '',
                pages: [{ url, ...homeContent }, ...extraPages.filter(Boolean)],
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

function chunkTerms(terms, batchSize) {
    const chunks = [];
    for (let i = 0; i < terms.length; i += batchSize) {
        chunks.push(terms.slice(i, i + batchSize));
    }
    return chunks;
}

function buildWebsiteContextBlock(websiteUrlTrim, scraped, homepageDiagnostic) {
    if (!websiteUrlTrim) {
        return {
            websiteContext: `Website URL: Not provided`,
            websiteContextStatus: 'no_url',
            websiteFetchDetail: null,
        };
    }
    if (scraped) {
        const pagesText = scraped.pages
            .map((p) => {
                const lines = [`[Page: ${p.url}]`];
                if (p.h1s.length) lines.push(`H1: ${p.h1s.join(' | ')}`);
                if (p.h2s.length) lines.push(`H2: ${p.h2s.join(' | ')}`);
                if (p.bodyText) lines.push(`Content: ${p.bodyText}`);
                return lines.join('\n');
            })
            .join('\n\n');
        return {
            websiteContext: `Website URL: ${websiteUrlTrim}
Page Title: ${scraped.title}
Meta Description: ${scraped.metaDesc}

Scanned Pages (${scraped.pages.length}):
${pagesText}`,
            websiteContextStatus: 'ok',
            websiteFetchDetail: null,
        };
    }
    const detail =
        homepageDiagnostic ||
        'We could not load this URL (bad link, empty page, 404/403, SSL, firewall, etc.). Save a working homepage URL, then scan again.';
    return {
        websiteContext: `Website URL: ${websiteUrlTrim}
Automated homepage fetch failed (${detail}). No page body is available — use ONLY the search terms below.`,
        websiteContextStatus: 'unreadable',
        websiteFetchDetail: detail,
    };
}

function buildChunkPrompt({
    chunkTerms,
    chunkIndex,
    chunkCount,
    termsForPrompt,
    accountTermCount,
    websiteContext,
    websiteContextStatus,
    rejectedNormalized,
}) {
    const hasWebsiteContent = websiteContextStatus === 'ok';
    const websitePrelude = hasWebsiteContent
        ? `BEFORE YOU BEGIN — SCAN THE WEBSITE:
Before evaluating any search terms, read the provided website content to understand:
- Every product and service this business offers
- What geographic area(s) they serve, if any
- Use this as the foundation for every decision below`
        : `WEBSITE CONTEXT UNAVAILABLE:
The automated homepage fetch failed. You have no page content — rely ONLY on the search terms below. Do not infer services, geography, or core industry themes from the domain or URL alone. Prefer fewer negatives.`;

    const geoRule = hasWebsiteContent
        ? `1. GEOGRAPHIC TERMS: If the business serves a specific local or regional area, add out-of-area location words as negatives. Extract only the location word, not the full phrase. If the business serves nationally or the area is unclear, skip geographic terms.`
        : `1. GEOGRAPHIC TERMS: Skip geographic negatives unless the query clearly signals wrong-location intent without website proof. When unsure, omit.`;

    const industryRule = hasWebsiteContent
        ? `2. NEVER add the business's own core industry terms as negatives (themes and role words that describe what paying customers actually search for to find this firm — analogous to \"marketing\"/\"agency\" for a marketer). If the site offers that service or audience, omit.`
        : `2. NEVER add broad industry or service role words as negatives unless the query unmistakably signals job-seeking, DIY, unrelated trade, or a competitor — you cannot verify core offerings without the site.`;

    const intentRule = hasWebsiteContent
        ? `5. Flag words that clearly signal wrong intent: competitor brand names, unrelated industries, job-seeking (\"careers\", \"jobs\", \"hiring\"), DIY/free intent (\"free\", \"template\", \"diy\") when unrelated, or irrelevant proper nouns — not mainstream ways of asking for services the website clearly provides.`
        : `5. Flag words that clearly signal wrong intent: competitor brand names, unrelated industries, job-seeking (\"careers\", \"jobs\", \"hiring\"), DIY/free intent (\"free\", \"template\", \"diy\") when unrelated, or irrelevant proper nouns. When intent is ambiguous, omit.`;

    const searchTermsTable = chunkTerms
        .map(
            (st, i) =>
                `${i + 1}. ${st.searchTerm} | Clicks: ${st.clicks} | Conversions: ${st.conversions} | Campaign: ${st.campaign}`,
        )
        .join('\n');

    const uniqueWords = [
        ...new Set([
            ...chunkTerms.flatMap((st) => st.searchTerm.toLowerCase().split(/\s+/)),
            ...chunkTerms.map((st) => st.searchTerm.toLowerCase()),
        ]),
    ].join(', ');

    const rejectedPromptBlock =
        rejectedNormalized.size === 0
            ? ''
            : `
USER-REJECTED AI SUGGESTIONS — never include any of these in negativeKeywords (the account owner already dismissed them), even if they appear in the search terms:
${[...rejectedNormalized].sort().join(', ')}

`;

    const accountScope =
        accountTermCount > termsForPrompt.length
            ? `This account has ${accountTermCount} search queries with clicks in the period. The full scan covers the top ${termsForPrompt.length} by clicks in ${chunkCount} batch(es). `
            : '';

    const scopeNote = `${accountScope}You are analyzing batch ${chunkIndex + 1} of ${chunkCount} (${chunkTerms.length} queries in this batch). Every negative MUST appear verbatim in this batch's list — do not assume anything about queries not shown.\n\n`;

    return `You are a Google Ads specialist helping identify negative keywords to add to a campaign.

Your job is to find words or phrases that signal a search is NOT from a potential customer of this business. Prefer precision over recall: when intent is ambiguous, do NOT include the term as a negative (avoid costing real leads).

${websitePrelude}

RULES:
${geoRule}
${industryRule}
3. NEVER add generic descriptors as negatives inside your returned strings — not even inside a multi-word suggestion (e.g. never output a keyword that contains the phrase \"near me\", \"best \", \"top \", standalone \"cheap\", standalone \"reviews\", standalone \"firm\", standalone \"services\", standalone \"company\", standalone \"local\"). Extract the real offending signal (competitor, wrong city, job-seeking token, unrelated niche token) instead, or omit.
4. DATA ONLY: Every keyword you return MUST be a word or phrase that appears verbatim in the search terms list below. Do NOT invent negatives.
${intentRule}
6. EXTRACTION RULE — always extract the smallest offending unit. Almost NEVER paste an entire multi-word search query back as one negative phrase (that destroys good traffic unless the ENTIRE query is verbatim a competitor or an unrelated tangent). Strip down to competitor brand, wrong geo token, franchise, salaries, unrelated product, etc.
7. COMPETITORS: Identify competitor brand names in the search terms using your industry knowledge and add them as negatives (smallest unmistakable substring that appears verbatim in the query).
8. When in doubt, leave it OUT of negativeKeywords entirely.
${rejectedPromptBlock}
${websiteContext}

${scopeNote}Search Terms (format: term | clicks | conversions | campaign):
${searchTermsTable}

Every unique word present across all search terms in this batch (your negatives MUST come only from this set):
${uniqueWords}

FINAL CHECK before writing JSON:
- Does each keyword appear word-for-word in the search terms list? If NO, remove it.
- Is this suggestion literally the FULL text of some search-query line without a disqualifier? If YES, remove it — shorten to smallest offending substring or omit.

OUTPUT FORMAT (required): Return exactly one JSON object. No markdown fences, preamble, or closing commentary.
{
  "negativeKeywords": ["keyword1", "keyword2"],
  "summary": {
    "totalSearchTerms": 0,
    "negativeCount": 0,
    "qualityPercentage": 0
  },
  "explanation": "Brief summary of your analysis for this batch."
}`;
}

async function invokeBedrockForChunk(prompt, onRetry) {
    const bedrockAbort = abortAfterMs(120000);
    const rawText = await invokeBedrockChat([{ role: 'user', content: prompt }], bedrockAbort);
    try {
        return parseAiRecommendationJson(rawText);
    } catch (parseErr) {
        console.warn('[AI] Bedrock returned non-JSON; retrying once.', rawText.slice(0, 500));
        if (onRetry) onRetry();
        const retryText = await invokeBedrockChat(
            [
                {
                    role: 'user',
                    content: `${prompt}\n\nCRITICAL: Your entire reply must be one JSON object only. No analysis, markdown, or text outside the JSON.`,
                },
            ],
            bedrockAbort,
        );
        return parseAiRecommendationJson(retryText);
    }
}

function validateChunkKeywords(parsed, chunkTerms, rejectedNormalized, googleNegativeTexts) {
    const sourcesMap = {};
    let keywords = (parsed.negativeKeywords || []).filter((kw) => {
        const kwLower = kw.toLowerCase().trim();
        const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
        const matches = chunkTerms
            .filter((st) => re.test(st.searchTerm.toLowerCase()))
            .map((st) => st.searchTerm);
        sourcesMap[kw] = matches;
        return matches.length > 0;
    });
    keywords = keywords.filter((kw) => !shouldDropAiNegativeSuggestion(kw, chunkTerms));
    keywords = keywords.filter((kw) => {
        const n = kw.toLowerCase().trim();
        return !rejectedNormalized.has(n) && !googleNegativeTexts.has(n);
    });
    for (const k of Object.keys(sourcesMap)) {
        if (!keywords.includes(k)) delete sourcesMap[k];
    }
    return { keywords, sourcesMap, explanation: parsed.explanation || '' };
}

function mergeKeywordLists(existingKeywords, existingSources, newKeywords, newSources) {
    const seen = new Set(existingKeywords.map((k) => k.toLowerCase().trim()));
    const keywords = [...existingKeywords];
    const sources = { ...existingSources };
    for (const kw of newKeywords) {
        const n = kw.toLowerCase().trim();
        if (seen.has(n)) continue;
        seen.add(n);
        keywords.push(kw);
        if (newSources[kw]) sources[kw] = newSources[kw];
    }
    return { keywords, sources };
}

function buildSummary(termsForPrompt, accountTermCount, negativeCount) {
    const summary = {
        totalSearchTerms: termsForPrompt.length,
        negativeCount,
        qualityPercentage:
            termsForPrompt.length > 0
                ? Math.round(((termsForPrompt.length - negativeCount) / termsForPrompt.length) * 100)
                : 100,
    };
    if (accountTermCount > termsForPrompt.length) {
        summary.totalSearchTermsInAccount = accountTermCount;
    }
    return summary;
}

function chunkAnalyzePercent(chunksCompleted, chunksTotal) {
    if (chunksTotal <= 0) return 32;
    const span = 61;
    return 32 + Math.round((chunksCompleted / chunksTotal) * span);
}

/**
 * @param {object} jobRow - ai_scan_jobs row
 * @param {(fields: object) => Promise<void>} persistProgress
 */
async function runAiScanJob(jobRow, persistProgress) {
    const payload = jobRow.payload || {};
    const termsForPrompt = payload.termsForPrompt || [];
    const accountTermCount = payload.accountTermCount || termsForPrompt.length;
    const websiteUrl = payload.websiteUrl || '';
    const rejectedNormalized = new Set(payload.rejectedNormalized || []);
    const googleNegativeTexts = new Set(payload.googleNegativeTexts || []);

    const batchSize = resolveAiBatchSize();
    const chunks = chunkTerms(termsForPrompt, batchSize);
    const chunksTotal = Math.max(chunks.length, 1);

    await persistProgress({
        chunks_total: chunksTotal,
        chunks_completed: 0,
        phase: 'scraping',
        percent: 25,
        label: 'Scanning website for context…',
    });

    const websiteUrlTrim = typeof websiteUrl === 'string' ? websiteUrl.trim() : '';
    let scraped = null;
    let homepageDiagnostic = null;

    if (websiteUrlTrim) {
        const scrapeTimeoutMs = 42000;
        const timedOutPayload = Object.freeze({
            scraped: null,
            homepageDiagnostic: `Site scan timed out after ${scrapeTimeoutMs / 1000}s (server very slow or blocking).`,
        });
        const scrapeResult = await Promise.race([
            scrapeWebsiteContext(websiteUrlTrim),
            new Promise((resolve) => setTimeout(() => resolve(timedOutPayload), scrapeTimeoutMs)),
        ]);
        scraped = scrapeResult.scraped;
        homepageDiagnostic = scrapeResult.homepageDiagnostic;
    }

    const { websiteContext, websiteContextStatus, websiteFetchDetail } = buildWebsiteContextBlock(
        websiteUrlTrim,
        scraped,
        homepageDiagnostic,
    );

    let accumulatedKeywords = [];
    let accumulatedSources = {};
    let lastExplanation = '';

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunkTermsList = chunks[chunkIndex];
        const chunkNum = chunkIndex + 1;

        await persistProgress({
            phase: 'analyzing',
            percent: chunkAnalyzePercent(chunkIndex, chunksTotal),
            label:
                chunksTotal > 1
                    ? `Analyzing batch ${chunkNum} of ${chunksTotal}…`
                    : 'Analyzing search terms with AI…',
        });

        const prompt = buildChunkPrompt({
            chunkTerms: chunkTermsList,
            chunkIndex,
            chunkCount: chunksTotal,
            termsForPrompt,
            accountTermCount,
            websiteContext,
            websiteContextStatus,
            rejectedNormalized,
        });

        const parsed = await invokeBedrockForChunk(prompt, async () => {
            await persistProgress({
                phase: 'analyzing',
                percent: chunkAnalyzePercent(chunkIndex, chunksTotal) + 2,
                label: `Retrying AI for batch ${chunkNum}…`,
            });
        });

        const { keywords, sourcesMap, explanation } = validateChunkKeywords(
            parsed,
            chunkTermsList,
            rejectedNormalized,
            googleNegativeTexts,
        );
        const merged = mergeKeywordLists(accumulatedKeywords, accumulatedSources, keywords, sourcesMap);
        accumulatedKeywords = merged.keywords;
        accumulatedSources = merged.sources;
        if (explanation) lastExplanation = explanation;

        const chunksCompleted = chunkIndex + 1;
        const partialResult = {
            negativeKeywords: accumulatedKeywords,
            negativeKeywordSources: accumulatedSources,
            summary: buildSummary(termsForPrompt, accountTermCount, accumulatedKeywords.length),
            explanation: lastExplanation,
            websiteContextStatus,
            websiteFetchDetail,
            partial: chunksCompleted < chunksTotal,
        };

        await persistProgress({
            chunks_completed: chunksCompleted,
            percent: chunkAnalyzePercent(chunksCompleted, chunksTotal),
            label:
                chunksCompleted < chunksTotal
                    ? `Batch ${chunksCompleted} of ${chunksTotal} complete — loading more…`
                    : 'Validating AI suggestions…',
            result: partialResult,
        });
    }

    await persistProgress({
        phase: 'validating',
        percent: 96,
        label: 'Validating AI suggestions…',
    });

    const finalKeywords = accumulatedKeywords.filter((kw) => {
        const kwLower = kw.toLowerCase().trim();
        const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
        return termsForPrompt.some((st) => re.test(st.searchTerm.toLowerCase()));
    });
    const finalSources = {};
    for (const kw of finalKeywords) {
        if (accumulatedSources[kw]) finalSources[kw] = accumulatedSources[kw];
    }

    return {
        negativeKeywords: finalKeywords,
        negativeKeywordSources: finalSources,
        summary: buildSummary(termsForPrompt, accountTermCount, finalKeywords.length),
        explanation: lastExplanation,
        websiteContextStatus,
        websiteFetchDetail,
        partial: false,
    };
}

module.exports = {
    runAiScanJob,
    resolveAiBatchSize,
};
