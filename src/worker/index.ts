import 'dotenv/config';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { and, asc, eq, isNotNull, lt, or, sql, gt, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscription, syncJob, garminAccount } from '../db/schema.js';
import { runCnToGlobalSync, type SyncProgress } from '../garmin/sync.js';
import { markAutoSync } from '../lib/plan.js';

const POLL_INTERVAL_MS = 3000;
const AUTO_SYNC_INTERVAL_HOURS = 2;
const PROGRESS_LOG_CAP = 200;

let stopped = false;

async function claimNextJob(): Promise<{ id: string; userId: string; mode: string } | null> {
  // Atomic claim using SQL
  const rows = await db.execute(sql`
    UPDATE sync_job
    SET status = 'running', started_at = NOW()
    WHERE id = (
      SELECT id FROM sync_job
      WHERE status = 'queued'
      ORDER BY queued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", mode
  `);
  const row = (rows.rows ?? rows)[0] as
    | { id: string; userId: string; mode: string }
    | undefined;
  return row ?? null;
}

async function updateProgress(jobId: string, progress: SyncProgress) {
  await db.execute(sql`
    UPDATE sync_job
    SET progress = jsonb_build_object(
      'stage', ${progress.stage}::text,
      'message', ${progress.message}::text,
      'total', ${progress.total},
      'completed', ${progress.completed},
      'scanned', ${progress.scanned},
      'uploaded', ${progress.uploaded},
      'skipped', ${progress.skipped},
      'failed', ${progress.failed},
      'percent', ${progress.percent}
    )
    WHERE id = ${jobId}
  `);
}

async function appendLog(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
  };
  await db.execute(sql`
    UPDATE sync_job
    SET progress = jsonb_set(
      coalesce(progress, '{}'::jsonb),
      '{logs}',
      coalesce(progress->'logs', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
    )
    WHERE id = ${jobId}
  `);
  // Trim logs to cap (best-effort)
  await db.execute(sql`
    UPDATE sync_job
    SET progress = jsonb_set(
      progress,
      '{logs}',
      (
        SELECT jsonb_agg(elem)
        FROM (
          SELECT elem FROM jsonb_array_elements(progress->'logs') WITH ORDINALITY AS t(elem, idx)
          ORDER BY idx DESC
          LIMIT ${PROGRESS_LOG_CAP}
        ) sub
      )
    )
    WHERE id = ${jobId} AND jsonb_array_length(progress->'logs') > ${PROGRESS_LOG_CAP}
  `);
}

async function processJob(job: { id: string; userId: string; mode: string }) {
  const { id, userId, mode } = job;
  console.log(`[worker] processing ${id} user=${userId} mode=${mode}`);
  await appendLog(id, 'info', `开始 ${mode} 同步`);
  try {
    const result = await runCnToGlobalSync(userId, {
      mode: mode as 'incremental' | 'history',
      onProgress: (p) => {
        // fire and forget; don't await each progress write
        updateProgress(id, p).catch(() => {});
      },
    });
    await db
      .update(syncJob)
      .set({
        status: 'success',
        finishedAt: new Date(),
        result: {
          uploaded: result.uploadedCount,
          skipped: result.skippedCount,
          failed: result.failedCount,
        },
      })
      .where(eq(syncJob.id, id));
    await appendLog(
      id,
      'info',
      `同步完成 上传${result.uploadedCount} 跳过${result.skippedCount} 失败${result.failedCount}`,
    );
    console.log(`[worker] ${id} success`);
  } catch (error) {
    const msg = (error as Error).message || String(error);
    await db
      .update(syncJob)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: msg,
      })
      .where(eq(syncJob.id, id));
    await appendLog(id, 'error', msg);
    console.error(`[worker] ${id} failed:`, msg);
  }
}

async function workerLoop() {
  while (!stopped) {
    try {
      const job = await claimNextJob();
      if (job) {
        await processJob(job);
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error('[worker] loop error:', error);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

/**
 * Cron tick — every 10 minutes, scan for Pro users whose last auto-sync was
 * more than AUTO_SYNC_INTERVAL_HOURS ago, and enqueue an incremental sync.
 */
async function autoSyncTick() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AUTO_SYNC_INTERVAL_HOURS * 3600_000);

  const candidates = await db
    .select({
      userId: subscription.userId,
      lastAutoSyncAt: subscription.lastAutoSyncAt,
    })
    .from(subscription)
    .where(
      and(
        eq(subscription.plan, 'pro'),
        eq(subscription.autoSyncEnabled, true),
        or(
          isNull(subscription.expiresAt),
          gt(subscription.expiresAt, now),
        ),
        or(
          isNull(subscription.lastAutoSyncAt),
          lt(subscription.lastAutoSyncAt, cutoff),
        ),
      ),
    );

  if (!candidates.length) return;
  console.log(`[cron] auto-sync candidates: ${candidates.length}`);

  for (const c of candidates) {
    // Skip if user has an active job
    const active = await db
      .select({ id: syncJob.id })
      .from(syncJob)
      .where(
        and(
          eq(syncJob.userId, c.userId),
          or(eq(syncJob.status, 'queued'), eq(syncJob.status, 'running')),
        ),
      )
      .limit(1);
    if (active[0]) continue;

    // Skip if Garmin accounts not configured for both regions
    const accs = await db
      .select({ region: garminAccount.region })
      .from(garminAccount)
      .where(eq(garminAccount.userId, c.userId));
    const regions = new Set(accs.map((a) => a.region));
    if (!regions.has('cn') || !regions.has('global')) continue;

    const id = crypto.randomUUID();
    await db.insert(syncJob).values({
      id,
      userId: c.userId,
      mode: 'incremental',
      trigger: 'cron',
      status: 'queued',
      progress: { logs: [] },
      queuedAt: new Date(),
    });
    await markAutoSync(c.userId);
    console.log(`[cron] enqueued auto-sync ${id} for user=${c.userId}`);
  }
}

function shutdown() {
  console.log('[worker] shutting down');
  stopped = true;
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[worker] starting');
console.log(`[worker] polling every ${POLL_INTERVAL_MS}ms`);
console.log(`[worker] auto-sync every ${AUTO_SYNC_INTERVAL_HOURS}h`);

// Cron: every 10 minutes
cron.schedule('*/10 * * * *', () => {
  autoSyncTick().catch((e) => console.error('[cron] error:', e));
});

// Run loop
workerLoop().catch((e) => {
  console.error('[worker] fatal:', e);
  process.exit(1);
});
