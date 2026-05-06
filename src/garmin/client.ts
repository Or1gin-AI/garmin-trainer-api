import garminPkg from '@gooin/garmin-connect';
import { MFAManager } from '@gooin/garmin-connect/dist/common/MFAManager.js';
const { GarminConnect } = garminPkg as { GarminConnect: any };
import path from 'node:path';
import fs from 'node:fs';
import {
  loadGarminAccount,
  persistGarminSession,
  clearGarminSession,
  type Region,
} from './store.js';
import { getRegionLabel, humanizeAuthError } from './utils.js';

const DEFAULT_TIMEOUT_MS = 30000;

function resolveTimeoutMs(): number {
  const v = Number(process.env.GARMIN_HTTP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 5000 ? v : DEFAULT_TIMEOUT_MS;
}

const DATA_ROOT = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildClient(
  region: Region,
  username?: string,
  password?: string,
): any {
  const config = {
    username: username || '',
    password: password || '',
    timeout: resolveTimeoutMs(),
  };
  return region === 'cn'
    ? new GarminConnect(config, 'garmin.cn')
    : new GarminConnect(config);
}

/**
 * MFA dir is per-user so concurrent users don't trample each other.
 */
export function getMfaManagerForUser(userId: string) {
  const dir = path.join(DATA_ROOT, 'mfa', userId);
  ensureDir(dir);
  return MFAManager.getInstance({ type: 'file', dir });
}

export interface AuthenticatedClient {
  client: any;
  profile: { fullName: string; userName: string; location: string };
}

/**
 * Authenticate a user's Garmin account for a given region.
 * Tries cached session first; falls back to username/password login.
 */
export async function authenticate(
  userId: string,
  region: Region,
  options: {
    interactiveSessionId?: string | null;
    onMfaPending?: (sessionId: string) => void;
  } = {},
): Promise<AuthenticatedClient> {
  const account = await loadGarminAccount(userId, region);
  if (!account) {
    throw new Error(
      `${getRegionLabel(region)}尚未配置账号，请先在控制台保存 Garmin 账号`,
    );
  }

  const client = buildClient(region, account.username, account.password);
  let authenticated = false;

  const session = account.session as { oauth1?: any; oauth2?: any } | null;
  const hasStoredSession = Boolean(session?.oauth1 && session?.oauth2);

  if (hasStoredSession) {
    try {
      await client.loadToken(session!.oauth1, session!.oauth2);
      authenticated = true;
    } catch {
      await clearGarminSession(userId, region);
    }
  }

  if (!authenticated) {
    if (!account.username || !account.password) {
      throw new Error(
        `${getRegionLabel(region)}本地会话已失效，请重新提交账号密码`,
      );
    }

    let watcher: NodeJS.Timeout | null = null;
    const interactiveSessionId = options.interactiveSessionId || null;

    if (interactiveSessionId) {
      const mfaManager = getMfaManagerForUser(userId);
      let notified = false;
      watcher = setInterval(async () => {
        if (notified) return;
        try {
          if (await mfaManager.hasSession(interactiveSessionId)) {
            notified = true;
            options.onMfaPending?.(interactiveSessionId);
          }
        } catch {
          // ignore
        }
      }, 500);
    }

    try {
      await client.login(
        account.username,
        account.password,
        interactiveSessionId || undefined,
      );
    } catch (error) {
      if (watcher) clearInterval(watcher);
      const msg = String((error as Error)?.message || '');
      if (msg.includes('需要MFA验证')) {
        throw new Error(
          `${getRegionLabel(region)}账号需要验证码，请先发起“验证 Garmin 连接”流程`,
        );
      }
      throw new Error(humanizeAuthError(region, error));
    } finally {
      if (watcher) clearInterval(watcher);
    }
  }

  const profile = await client.getUserProfile();
  if (!profile?.fullName && !profile?.userName) {
    throw new Error(
      `${getRegionLabel(region)}登录失败，请检查账号密码或网络环境`,
    );
  }

  await persistGarminSession(
    userId,
    region,
    typeof client.exportToken === 'function' ? client.exportToken() : null,
    {
      fullName: profile.fullName || '',
      userName: profile.userName || '',
      location: profile.location || '',
    },
  );

  return {
    client,
    profile: {
      fullName: profile.fullName || '',
      userName: profile.userName || '',
      location: profile.location || '',
    },
  };
}

/**
 * Submit an MFA code that was previously requested for an interactive login.
 */
export async function submitMfa(
  userId: string,
  interactiveSessionId: string,
  code: string,
): Promise<void> {
  const mfaManager = getMfaManagerForUser(userId);
  await mfaManager.submitMFACode(interactiveSessionId, code);
}
