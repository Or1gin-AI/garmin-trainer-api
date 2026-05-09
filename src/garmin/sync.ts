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

export interface DirectionStats {
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface SyncResult {
  scanned: number;
  totalCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  cnToGlobal: DirectionStats;
  globalToCn: DirectionStats;
  errors: {
    direction: 'cnToGlobal' | 'globalToCn';
    activityId: string | number;
    name: string;
    message: string;
  }[];
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
  compareWindow?: number;
  onProgress?: (p: SyncProgress) => void;
}

export async function runBidirectionalSync(
  userId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const compareWindow = Number(options.compareWindow ?? 40);

  const [{ client: cnClient }, { client: globalClient }] = await Promise.all([
    authenticate(userId, 'cn'),
    authenticate(userId, 'global'),
  ]);

  // Both sides receive uploads now
  await Promise.all([
    ensureUploadConsent(cnClient),
    ensureUploadConsent(globalClient),
  ]);

  const uploaded: MappedActivity[] = [];
  const errors: SyncResult['errors'] = [];
  const cnToGlobal: DirectionStats = { uploaded: 0, skipped: 0, failed: 0 };
  const globalToCn: DirectionStats = { uploaded: 0, skipped: 0, failed: 0 };

  options.onProgress?.(
    buildProgress({ stage: 'preparing', message: '正在读取双区最新记录' }),
  );

  const [cnList, globalList] = await Promise.all([
    cnClient.getActivities(0, compareWindow) as Promise<RawActivity[]>,
    globalClient.getActivities(0, compareWindow) as Promise<RawActivity[]>,
  ]);

  const cnSigs = new Set(cnList.map((a) => activitySignature(a)));
  const globalSigs = new Set(globalList.map((a) => activitySignature(a)));

  // Activities present in CN but missing from Global → push CN→Global
  const toGlobal = cnList
    .filter((a) => !globalSigs.has(activitySignature(a)))
    .sort((a, b) =>
      String(a.startTimeLocal).localeCompare(String(b.startTimeLocal)),
    );

  // Activities present in Global but missing from CN → push Global→CN
  const toCn = globalList
    .filter((a) => !cnSigs.has(activitySignature(a)))
    .sort((a, b) =>
      String(a.startTimeLocal).localeCompare(String(b.startTimeLocal)),
    );

  const scanned = cnList.length + globalList.length;
  const total = toGlobal.length + toCn.length;
  let completed = 0;

  options.onProgress?.(
    buildProgress({
      stage: 'syncing',
      message: total
        ? `共发现 ${toGlobal.length} 条 CN→国际、${toCn.length} 条 国际→CN 待同步`
        : '两区已同步，无新增记录',
      total,
      completed,
      scanned,
    }),
  );

  async function runDirection(
    direction: 'cnToGlobal' | 'globalToCn',
    pending: RawActivity[],
  ) {
    const stats = direction === 'cnToGlobal' ? cnToGlobal : globalToCn;
    const sourceClient = direction === 'cnToGlobal' ? cnClient : globalClient;
    const targetClient = direction === 'cnToGlobal' ? globalClient : cnClient;
    const sourceRegion: 'cn' | 'global' =
      direction === 'cnToGlobal' ? 'cn' : 'global';
    const targetRegion: 'cn' | 'global' =
      direction === 'cnToGlobal' ? 'global' : 'cn';
    const targetSigs = direction === 'cnToGlobal' ? globalSigs : cnSigs;
    const dirLabel =
      direction === 'cnToGlobal' ? 'CN→国际' : '国际→CN';

    for (let i = 0; i < pending.length; i += 1) {
      const activity = pending[i];
      try {
        await transferActivity(sourceClient, targetClient, activity);
        stats.uploaded += 1;
        uploaded.push(mapActivity(activity, sourceRegion));
        targetSigs.add(activitySignature(activity));
      } catch (error) {
        if (isDuplicateUploadConflict(error)) {
          stats.skipped += 1;
          targetSigs.add(activitySignature(activity));
        } else {
          stats.failed += 1;
          errors.push({
            direction,
            activityId: activity.activityId,
            name: activity.activityName || '未命名活动',
            message: humanizeSyncFailure(error, targetRegion),
          });
        }
      }
      completed += 1;
      options.onProgress?.(
        buildProgress({
          stage: 'syncing',
          message: `${dirLabel} ${i + 1}/${pending.length}`,
          total,
          completed,
          scanned,
          uploaded: cnToGlobal.uploaded + globalToCn.uploaded,
          skipped: cnToGlobal.skipped + globalToCn.skipped,
          failed: cnToGlobal.failed + globalToCn.failed,
        }),
      );
    }
  }

  await runDirection('cnToGlobal', toGlobal);
  await runDirection('globalToCn', toCn);

  const uploadedCount = cnToGlobal.uploaded + globalToCn.uploaded;
  const skippedCount = cnToGlobal.skipped + globalToCn.skipped;
  const failedCount = cnToGlobal.failed + globalToCn.failed;

  options.onProgress?.(
    buildProgress({
      stage: failedCount > 0 ? 'failed' : 'finishing',
      message:
        failedCount > 0
          ? `同步完成（${failedCount} 条失败）`
          : '同步完成',
      total,
      completed,
      scanned,
      uploaded: uploadedCount,
      skipped: skippedCount,
      failed: failedCount,
    }),
  );

  return {
    scanned,
    totalCount: total,
    uploadedCount,
    skippedCount,
    failedCount,
    cnToGlobal,
    globalToCn,
    errors,
    uploaded,
  };
}
