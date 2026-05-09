export interface RawActivity {
  activityId: string | number;
  activityName?: string;
  activityType?: { typeKey?: string };
  startTimeLocal?: string;
  distance?: number;
  duration?: number;
  averageSpeed?: number;
  averageHR?: number;
}

export interface MappedActivity {
  id: string;
  region: 'cn' | 'global';
  activityId: string | number;
  signature: string;
  name: string;
  type: string;
  startTimeLocal: string | null;
  distanceKm: number;
  durationMin: number;
  averageHr: number | null;
  averagePaceMinPerKm: number | null;
  averagePaceText: string | null;
}

export function activitySignature(activity: RawActivity): string {
  return [
    activity.startTimeLocal || '',
    activity.activityType?.typeKey || 'unknown',
    Math.round(activity.distance || 0),
    Math.round(activity.duration || 0),
  ].join('|');
}

export function paceFromSpeed(averageSpeed: number | undefined) {
  if (!averageSpeed || averageSpeed <= 0) {
    return { value: null, text: null };
  }
  const minutesPerKm = 1000 / averageSpeed / 60;
  const minutes = Math.floor(minutesPerKm);
  const seconds = Math.round((minutesPerKm - minutes) * 60);
  return {
    value: Number(minutesPerKm.toFixed(2)),
    text: `${minutes}:${String(seconds).padStart(2, '0')}`,
  };
}

export function mapActivity(
  activity: RawActivity,
  region: 'cn' | 'global',
): MappedActivity {
  const pace = paceFromSpeed(activity.averageSpeed);
  return {
    id: `${region}-${activity.activityId}`,
    region,
    activityId: activity.activityId,
    signature: activitySignature(activity),
    name: activity.activityName || '未命名活动',
    type: activity.activityType?.typeKey || 'unknown',
    startTimeLocal: activity.startTimeLocal || null,
    distanceKm: Number(((activity.distance || 0) / 1000).toFixed(2)),
    durationMin: Number(((activity.duration || 0) / 60).toFixed(1)),
    averageHr: activity.averageHR || null,
    averagePaceMinPerKm: pace.value,
    averagePaceText: pace.text,
  };
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function getRegionLabel(region: 'cn' | 'global') {
  return region === 'cn' ? '国区' : '国际区';
}

export function getErrorStatus(error: unknown): number {
  const e = error as { response?: { status?: number }; status?: number; statusCode?: number };
  return Number(e?.response?.status || e?.status || e?.statusCode || 0);
}

export function isDuplicateUploadConflict(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = String((error as Error)?.message || '');
  return status === 409 || message.includes('HTTP Error (409): Conflict');
}

export function isRetryableTransferError(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = String((error as Error)?.message || '');
  if (!message && !status) return false;
  if (
    message.includes('Request Timeout') ||
    message.includes('ECONNABORTED') ||
    message.includes('Network error')
  ) {
    return true;
  }
  return [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

export function humanizeSyncFailure(error: unknown): string {
  const message = String((error as Error)?.message || '');
  if (message.includes('HTTP Error (412): Precondition Failed')) {
    return '国际区账号拒绝活动导入。这个账号还没有授予上传 consent，请先登录国际区 Garmin Connect 网页手动完成一次活动导入授权后再重试。';
  }
  if (isRetryableTransferError(error)) {
    return 'Garmin 服务器响应超时或临时异常。重新发起同步会从断点附近继续，已成功的记录会被自动跳过。';
  }
  return message || '同步失败';
}

export function humanizeAuthError(
  region: 'cn' | 'global',
  error: unknown,
): string {
  const message = String((error as Error)?.message || '');
  const regionLabel = getRegionLabel(region);
  if (message.includes('HTTP Error (429)') || message.includes('Too Many Requests')) {
    return `${regionLabel}Garmin 服务器对当前请求节流（429）。请稍后再试，如果反复出现请告诉作者，可能需要换出口 IP。`;
  }
  if (message.includes('DI token exchange failed')) {
    return `${regionLabel}DI 令牌兑换失败。常见原因：service ticket 已被使用过、过期（CAS ticket 通常 5 分钟内有效），或 client_id 全部失效。请重新点"连接 Garmin"获取新 ticket。`;
  }
  if (message.includes('No OAuth2 token available')) {
    return `${regionLabel}登录失败：无法获取 OAuth 令牌，请检查账号密码或稍后重试`;
  }
  if (message.includes('Cannot find module')) {
    return `${regionLabel}登录依赖缺失：${message}`;
  }
  return message || `${regionLabel}登录失败`;
}
