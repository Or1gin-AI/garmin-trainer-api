import garminPkg from '@gooin/garmin-connect';
import { UrlClass } from '@gooin/garmin-connect/dist/garmin/UrlClass.js';
import path from 'node:path';
import fs from 'node:fs';
import {
  loadGarminAccount,
  persistGarminSession,
  clearGarminSession,
  type Region,
} from './store.js';
import { getRegionLabel, humanizeAuthError } from './utils.js';

const { GarminConnect } = garminPkg as { GarminConnect: any };

const DEFAULT_TIMEOUT_MS = 30000;

function resolveTimeoutMs(): number {
  const v = Number(process.env.GARMIN_HTTP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 5000 ? v : DEFAULT_TIMEOUT_MS;
}

const DATA_ROOT = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_ROOT);

function buildClient(region: Region): any {
  // Browser-ticket flow doesn't actually use the username/password —
  // the underlying lib still requires the fields to exist.
  const config = {
    username: `browser-auth-${region}@local`,
    password: 'browser-auth-session',
    timeout: resolveTimeoutMs(),
  };
  return region === 'cn'
    ? new GarminConnect(config, 'garmin.cn')
    : new GarminConnect(config);
}

function getRegionUrl(region: Region): UrlClass {
  return new UrlClass(region === 'cn' ? 'garmin.cn' : 'garmin.com');
}

/**
 * Build the Garmin "portal SSO" sign-in URL — the modern branded login page
 * (gym photo + Forgot Password link). After a successful login by the user,
 * Garmin redirects the browser back to `callbackUrl` with `?ticket=ST-...`.
 *
 * The legacy `/sso/signin?id=gauth-widget` URL renders the bare-bones embed
 * widget instead; we explicitly avoid it.
 */
export function buildBrowserLoginUrl(region: Region, callbackUrl: string): string {
  const url = getRegionUrl(region);
  const locale = region === 'cn' ? 'zh-CN' : 'en-US';
  const params = new URLSearchParams({
    clientId: 'GarminConnect',
    service: callbackUrl,
  });
  return `${url.GARMIN_SSO_ORIGIN}/portal/sso/${locale}/sign-in?${params.toString()}`;
}

export interface AuthenticatedClient {
  client: any;
  profile: { fullName: string; userName: string; location: string };
}

/**
 * Exchange a Garmin service ticket (returned from the official SSO login
 * window) for OAuth1 + OAuth2 tokens, and persist them encrypted under userId.
 *
 * The user never gives us their Garmin password — we only ever see the
 * post-login service ticket from the redirect.
 */
export async function authenticateWithBrowserTicket(
  userId: string,
  region: Region,
  ticket: string,
): Promise<AuthenticatedClient> {
  const trimmed = String(ticket || '').trim();
  if (!trimmed) {
    throw new Error(`${getRegionLabel(region)}浏览器登录回调缺少 ticket`);
  }

  const client = buildClient(region);

  try {
    await client.client.fetchOauthConsumer();
    const oauth1 = await client.client.getOauth1Token(trimmed);
    await client.client.exchange(oauth1);
  } catch (error) {
    throw new Error(humanizeAuthError(region, error));
  }

  const profile = await client.getUserProfile();
  if (!profile?.fullName && !profile?.userName) {
    throw new Error(
      `${getRegionLabel(region)}登录成功，但读不到 Garmin 资料，请稍后重试`,
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
 * Authenticate by loading the cached session token. There is no
 * password fallback — the user must complete the official Garmin login
 * window again if the session expired.
 */
export async function authenticate(
  userId: string,
  region: Region,
): Promise<AuthenticatedClient> {
  const account = await loadGarminAccount(userId, region);
  if (!account) {
    throw new Error(
      `${getRegionLabel(region)}尚未连接 Garmin，请在控制台点击"连接 Garmin"完成登录`,
    );
  }

  const session = account.session as { oauth1?: any; oauth2?: any } | null;
  if (!session?.oauth1 || !session?.oauth2) {
    throw new Error(
      `${getRegionLabel(region)}本地会话缺失，请重新连接 Garmin`,
    );
  }

  const client = buildClient(region);
  try {
    await client.loadToken(session.oauth1, session.oauth2);
  } catch {
    await clearGarminSession(userId, region);
    throw new Error(
      `${getRegionLabel(region)}本地会话已失效，请重新连接 Garmin`,
    );
  }

  const profile = await client.getUserProfile();
  if (!profile?.fullName && !profile?.userName) {
    throw new Error(
      `${getRegionLabel(region)}会话有效但读不到 Garmin 资料，请稍后重试`,
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
