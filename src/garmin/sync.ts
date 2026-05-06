import path from 'node:path';
import fs from 'node:fs';
import decompress from 'decompress';
import { authenticate } from './client.js';
import {
  activitySignature,
  delay,
  isDuplicateUploadConflict,
  isRetryableTransferError,
  humanizeSyncFailure,
  mapActivity,
  type MappedActivity,
  type RawActivity,
} from './utils.js';

const DATA_ROOT = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
const TEMP_DIR = path.join(DATA_ROOT, 'temp');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function removeDir(dir: string) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

async function downloadActivityFile(sourceClient: any, activityId: string | number) {
  const tempDir = path.join(TEMP_DIR, `${activityId}-${Date.now()}`);
  ensureDir(tempDir);
  try {
    const activity = await sourceClient.getActivity({ activityId });
    await sourceClient.downloadOriginalActivityData(activity, tempDir);
    const before = walkFiles(tempDir);
    const zipPath = before.find((f) => f.endsWith('.zip'));
    if (!zipPath) throw new Error(`活动 ${activityId} 下载成功，但未找到原始压缩包`);
    await decompress(zipPath, tempDir);
    const all = walkFiles(tempDir);
    const fitFile = all.find((f) => /\.(fit|gpx|tcx)$/i.test(f));
    if (!fitFile) throw new Error(`活动 ${activityId} 解压后未找到 .fit/.gpx/.tcx 文件`);
    return { fitFile, cleanup: () => removeDir(tempDir) };
  } catch (error) {
    removeDir(tempDir);
    throw error;
  }
}

async function transferActivity(
  sourceClient: any,
  targetClient: any,
  activity: RawActivity,
  maxAttempts = 5,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let cleanup: (() => void) | null = null;
    try {
      const dl = await downloadActivityFile(sourceClient, activity.activityId);
      cleanup = dl.cleanup;
      await targetClient.uploadActivity(dl.fitFile);
      return;
    } catch (error) {
      lastError = error;
      if (isDuplicateUploadConflict(error)) {
        (error as any).isDuplicateUploadConflict = true;
        throw error;
      }
      if (!isRetryableTransferError(error)) throw error;
      if (attempt < maxAttempts) await delay(1500 * attempt);
    } finally {
      cleanup?.();
    }
  }
  throw lastError;
}

async function ensureUploadConsent(client: any) {
  if (typeof client.consentGrant !== 'function') return;
  try {
    await client.consentGrant();
  } catch {
    // older Garmin endpoints may not support consent grant
  }
}

export interface SyncProgress {
  stage: 'preparing' | 'syncing' | 'finishing' | 'succeeded' | 'failed';
  message: string;
  total: number | null;
  completed: number;
  scanned: number;
  uploaded: number;
  skipped: number;
  failed: number;
  pending: number | null;
  percent: number | null;
}

export interface SyncResult {
  scanned: number;
  totalCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  errors: { activityId: string | number; name: string; message: string }[];
  uploaded: MappedActivity[];
}

function buildProgress(p: Partial<SyncProgress>): SyncProgress {
  const total = p.total ?? null;
  const completed = Math.max(0, p.completed ?? 0);
  return {
    stage: p.stage ?? 'syncing',
    message: p.message ?? '',
    total,
    completed,
    scanned: p.scanned ?? 0,
    uploaded: p.uploaded ?? 0,
    skipped: p.skipped ?? 0,
    failed: p.failed ?? 0,
    pending: total === null ? null : Math.max(total - completed, 0),
    percent:
      total === null
        ? null
        : total <= 0
          ? 100
          : Math.min(100, Math.round((completed / total) * 100)),
  };
}

export interface SyncOptions {
  mode: 'incremental' | 'history';
  maxActivities?: number | null;
  startIndex?: number;
  compareWindow?: number;
  historyPageSize?: number;
  onProgress?: (p: SyncProgress) => void;
}

export async function runCnToGlobalSync(
  userId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const compareWindow = Number(options.compareWindow ?? 40);
  const historyPageSize = Number(options.historyPageSize ?? 50);

  const [{ client: cnClient }, { client: globalClient }] = await Promise.all([
    authenticate(userId, 'cn'),
    authenticate(userId, 'global'),
  ]);

  await ensureUploadConsent(globalClient);

  const uploaded: MappedActivity[] = [];
  const errors: SyncResult['errors'] = [];
  let scanned = 0;
  let skipped = 0;
  let failed = 0;
  let totalForResult: number | null = null;

  if (options.mode === 'incremental') {
    const [cnList, globalList] = await Promise.all([
      cnClient.getActivities(0, compareWindow),
      globalClient.getActivities(0, compareWindow),
    ]);
    const globalSigs = new Set(
      (globalList as RawActivity[]).map((a) => activitySignature(a)),
    );
    const pending = (cnList as RawActivity[])
      .filter((a) => !globalSigs.has(activitySignature(a)))
      .sort((a, b) =>
        String(a.startTimeLocal).localeCompare(String(b.startTimeLocal)),
      );
    totalForResult = pending.length;
    scanned = (cnList as RawActivity[]).length;

    options.onProgress?.(
      buildProgress({
        stage: 'syncing',
        message: pending.length ? '正在同步新增记录' : '没有发现需要同步的新记录',
        total: pending.length,
        completed: 0,
        scanned,
      }),
    );

    for (let i = 0; i < pending.length; i += 1) {
      const activity = pending[i];
      try {
        await transferActivity(cnClient, globalClient, activity);
        uploaded.push(mapActivity(activity, 'cn'));
      } catch (error) {
        if (isDuplicateUploadConflict(error)) {
          skipped += 1;
          globalSigs.add(activitySignature(activity));
        } else {
          failed += 1;
          errors.push({
            activityId: activity.activityId,
            name: activity.activityName || '未命名活动',
            message: String((error as Error).message || ''),
          });
          options.onProgress?.(
            buildProgress({
              stage: 'failed',
              message: `同步在第 ${i + 1}/${pending.length} 条停止`,
              total: pending.length,
              completed: i + 1,
              scanned,
              uploaded: uploaded.length,
              skipped,
              failed,
            }),
          );
          throw new Error(humanizeSyncFailure(error));
        }
      }
      options.onProgress?.(
        buildProgress({
          stage: 'syncing',
          message: `正在同步新增记录 ${i + 1}/${pending.length}`,
          total: pending.length,
          completed: i + 1,
          scanned,
          uploaded: uploaded.length,
          skipped,
          failed,
        }),
      );
    }
  } else {
    options.onProgress?.(
      buildProgress({ stage: 'preparing', message: '正在读取国际区已有记录' }),
    );

    const targetSigs = new Set<string>();
    let pageOffset = 0;
    while (true) {
      const batch = (await globalClient.getActivities(
        pageOffset,
        historyPageSize,
      )) as RawActivity[];
      if (!batch.length) break;
      for (const a of batch) targetSigs.add(activitySignature(a));
      pageOffset += batch.length;
      if (batch.length < historyPageSize) break;
    }

    let offset = Number.isFinite(Number(options.startIndex))
      ? Number(options.startIndex)
      : 0;
    let remaining = options.maxActivities ?? null;

    // Pre-count for progress total
    let totalCount = 0;
    {
      let cursor = offset;
      let rem = remaining;
      while (true) {
        const sz = rem ? Math.min(historyPageSize, rem) : historyPageSize;
        const batch = (await cnClient.getActivities(cursor, sz)) as RawActivity[];
        if (!batch.length) break;
        totalCount += batch.length;
        cursor += batch.length;
        if (rem) {
          rem -= batch.length;
          if (rem <= 0) break;
        }
        if (batch.length < sz) break;
      }
    }
    totalForResult = totalCount;

    options.onProgress?.(
      buildProgress({
        stage: totalCount > 0 ? 'syncing' : 'succeeded',
        message:
          totalCount > 0
            ? `共发现 ${totalCount} 条国区记录，开始同步`
            : '国区没有可同步的运动记录',
        total: totalCount,
        completed: 0,
      }),
    );

    while (true) {
      const sz = remaining ? Math.min(historyPageSize, remaining) : historyPageSize;
      const batch = (await cnClient.getActivities(offset, sz)) as RawActivity[];
      if (!batch.length) break;

      for (const activity of batch) {
        scanned += 1;
        const sig = activitySignature(activity);
        if (!targetSigs.has(sig)) {
          try {
            await transferActivity(cnClient, globalClient, activity);
            uploaded.push(mapActivity(activity, 'cn'));
            targetSigs.add(sig);
          } catch (error) {
            if (isDuplicateUploadConflict(error)) {
              skipped += 1;
              targetSigs.add(sig);
            } else {
              failed += 1;
              errors.push({
                activityId: activity.activityId,
                name: activity.activityName || '未命名活动',
                message: String((error as Error).message || ''),
              });
              options.onProgress?.(
                buildProgress({
                  stage: 'failed',
                  message: `同步在第 ${scanned}/${totalCount} 条停止`,
                  total: totalCount,
                  completed: scanned,
                  scanned,
                  uploaded: uploaded.length,
                  skipped,
                  failed,
                }),
              );
              throw new Error(humanizeSyncFailure(error));
            }
          }
        } else {
          skipped += 1;
        }
        options.onProgress?.(
          buildProgress({
            stage: 'syncing',
            message: `正在同步 ${scanned}/${totalCount} 条`,
            total: totalCount,
            completed: scanned,
            scanned,
            uploaded: uploaded.length,
            skipped,
            failed,
          }),
        );
      }

      offset += batch.length;
      if (remaining) {
        remaining -= batch.length;
        if (remaining <= 0) break;
      }
      if (batch.length < sz) break;
    }
  }

  options.onProgress?.(
    buildProgress({
      stage: 'finishing',
      message: '同步完成',
      total: totalForResult ?? scanned,
      completed:
        options.mode === 'incremental'
          ? uploaded.length + skipped + failed
          : scanned,
      scanned,
      uploaded: uploaded.length,
      skipped,
      failed,
    }),
  );

  return {
    scanned,
    totalCount: totalForResult ?? scanned,
    uploadedCount: uploaded.length,
    skippedCount: skipped,
    failedCount: failed,
    errors,
    uploaded,
  };
}
