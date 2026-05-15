function resolveStaleMinutes() {
    const raw = parseInt(process.env.AI_SCAN_STALE_MINUTES || '15', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

function resolveRetentionDays() {
    const raw = parseInt(process.env.AI_SCAN_RETENTION_DAYS || '1', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Delete scan rows older than AI_SCAN_RETENTION_DAYS (default 1). */
async function purgeOldAiScanJobs(dbPool) {
    const days = resolveRetentionDays();
    const { rowCount } = await dbPool.query(
        `DELETE FROM ai_scan_jobs
         WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
        [days],
    );
    if (rowCount > 0) {
        console.log(`[AI worker] Purged ${rowCount} scan job(s) older than ${days} day(s)`);
    }
    return rowCount;
}

async function requeueStaleAiScanJobs(dbPool) {
    const mins = resolveStaleMinutes();
    const { rowCount } = await dbPool.query(
        `UPDATE ai_scan_jobs
         SET status = 'queued',
             phase = 'queued',
             label = 'Requeued after worker interruption…',
             started_at = NULL,
             updated_at = NOW()
         WHERE status = 'running'
           AND updated_at < NOW() - ($1 * INTERVAL '1 minute')`,
        [mins],
    );
    if (rowCount > 0) {
        console.log(`[AI worker] Requeued ${rowCount} stale scan job(s)`);
    }
    return rowCount;
}

async function claimNextAiScanJob(dbPool) {
    const { rows } = await dbPool.query(
        `UPDATE ai_scan_jobs
         SET status = 'running',
             phase = 'preparing',
             percent = 10,
             label = 'Preparing search terms for analysis…',
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE scan_id = (
             SELECT scan_id FROM ai_scan_jobs
             WHERE status = 'queued'
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         RETURNING *`,
    );
    return rows[0] || null;
}

async function updateAiScanJob(dbPool, scanId, fields) {
    const sets = [];
    const vals = [];
    let i = 1;
    const allowed = [
        'status',
        'phase',
        'percent',
        'label',
        'chunks_total',
        'chunks_completed',
        'result',
        'error_message',
        'completed_at',
    ];
    for (const key of allowed) {
        if (fields[key] !== undefined) {
            sets.push(`${key} = $${i}`);
            vals.push(fields[key]);
            i += 1;
        }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');
    vals.push(scanId);
    await dbPool.query(
        `UPDATE ai_scan_jobs SET ${sets.join(', ')} WHERE scan_id = $${i}`,
        vals,
    );
}

async function getAiScanJob(dbPool, scanId) {
    const { rows } = await dbPool.query(
        'SELECT * FROM ai_scan_jobs WHERE scan_id = $1',
        [scanId],
    );
    return rows[0] || null;
}

function jobRowToProgress(row) {
    if (!row) {
        return { active: false, phase: 'unknown', percent: 0, label: 'Waiting for scan…' };
    }
    const status = String(row.status || '');
    const active = status === 'queued' || status === 'running';
    return {
        active,
        status,
        phase: row.phase || status,
        percent: Number(row.percent) || 0,
        label: row.label || '',
        chunksTotal: Number(row.chunks_total) || 0,
        chunksCompleted: Number(row.chunks_completed) || 0,
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    };
}

module.exports = {
    requeueStaleAiScanJobs,
    purgeOldAiScanJobs,
    claimNextAiScanJob,
    updateAiScanJob,
    getAiScanJob,
    jobRowToProgress,
};
