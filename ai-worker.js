require('dotenv').config();
const { dbPool } = require('./lib/db-pool');
const { runAiScanJob } = require('./lib/ai-scan');
const {
    requeueStaleAiScanJobs,
    purgeOldAiScanJobs,
    claimNextAiScanJob,
    updateAiScanJob,
} = require('./lib/ai-scan-jobs');

function resolvePollMs() {
    const raw = parseInt(process.env.AI_WORKER_POLL_MS || '1500', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}

function resolveConcurrency() {
    const raw = parseInt(process.env.AI_WORKER_CONCURRENCY || '2', 10);
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 8) : 2;
}

const POLL_MS = resolvePollMs();
const MAX_CONCURRENT = resolveConcurrency();
const CLEANUP_INTERVAL_MS = (() => {
    const raw = parseInt(process.env.AI_SCAN_CLEANUP_INTERVAL_MS || String(60 * 60 * 1000), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();
let activeJobs = 0;
let lastCleanupAt = 0;

async function persistProgress(scanId, fields) {
    await updateAiScanJob(dbPool, scanId, fields);
}

async function processJob(jobRow) {
    const scanId = jobRow.scan_id;
    try {
        const finalResult = await runAiScanJob(jobRow, (fields) => persistProgress(scanId, fields));

        await updateAiScanJob(dbPool, scanId, {
            status: 'complete',
            phase: 'complete',
            percent: 100,
            label: 'AI scan complete.',
            result: finalResult,
            completed_at: new Date(),
        });
        console.log(`[AI worker] Scan complete: ${scanId}`);
    } catch (error) {
        console.error(`[AI worker] Scan failed ${scanId}:`, error);
        const aborted =
            error.name === 'AbortError' ||
            /abort/i.test(String(error.message || '')) ||
            /timeout/i.test(String(error.message || ''));
        const details = aborted
            ? 'Bedrock analysis timed out. The site scrape may have been slow; try again or use a lighter homepage URL.'
            : error.message || 'AI scan failed.';
        await updateAiScanJob(dbPool, scanId, {
            status: 'error',
            phase: 'error',
            percent: 100,
            label: details,
            error_message: details,
            completed_at: new Date(),
        });
    }
}

async function tick() {
    await requeueStaleAiScanJobs(dbPool);

    if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        lastCleanupAt = Date.now();
        await purgeOldAiScanJobs(dbPool);
    }

    while (activeJobs < MAX_CONCURRENT) {
        const job = await claimNextAiScanJob(dbPool);
        if (!job) break;

        activeJobs += 1;
        console.log(`[AI worker] Claimed scan ${job.scan_id} (active ${activeJobs}/${MAX_CONCURRENT})`);
        void processJob(job).finally(() => {
            activeJobs = Math.max(0, activeJobs - 1);
        });
    }
}

async function main() {
    console.log(`[AI worker] Started (poll=${POLL_MS}ms, concurrency=${MAX_CONCURRENT})`);
    await requeueStaleAiScanJobs(dbPool);
    await purgeOldAiScanJobs(dbPool);
    lastCleanupAt = Date.now();

    const loop = async () => {
        try {
            await tick();
        } catch (err) {
            console.error('[AI worker] Tick error:', err);
        }
        setTimeout(loop, POLL_MS);
    };
    void loop();
}

main().catch((err) => {
    console.error('[AI worker] Fatal:', err);
    process.exit(1);
});
