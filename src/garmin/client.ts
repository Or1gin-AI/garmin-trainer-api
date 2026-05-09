import garminPkg from '@gooin/garmin-connect';
import path from 'node:path';
import fs from 'node:fs';
import {
  loadGarminAccount,
  persistGarminSession,
  clearGarminSession,
  type Region,
} from './store.js';
import { getRegionLabel, humanizeAuthError } from './utils.js';
import {
  diApiHeaders,
  exchangeServiceTicketForDi,
  refreshDiToken,
  type DiTokenSet,
} from './di-auth.js';

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

export interface AuthenticatedClient {
  client: any;
  profile: { fullName: string; userName: string; location: string };
}

/**
 * Lib-shaped oauth2 token plus a couple of internal fields we need to drive
 * DI refresh ourselves. The lib's request interceptor only reads
 * `access_token`; the prefix-`__` fields ride along untouched.
 */
interface DiOauth2Token {
  access_token: string;
  refresh_token: string | null;
  token_type: 'Bearer';
  expires_in: number;
  expires_at: number;
  scope: string | null;
  __di: true;
  __di_client_id: string;
  __region: Region;
}

// `client.loadToken(oauth1, oauth2)` requires a truthy oauth1, but our
// patched `refreshOauth2Token` never reads it — the only purpose of this
// placeholder is to satisfy the lib's signature check. Make the value
// obvious so a human poking at the encrypted blob in postgres can tell.
const DI_OAUTH1_PLACEHOLDER = {
  oauth_token: 'di-bridge-no-oauth1',
  oauth_token_secret: 'di-bridge-no-oauth1',
};

function toLibOauth2(di: DiTokenSet, region: Region): DiOauth2Token {
  return {
    access_token: di.access_token,
    refresh_token: di.refresh_token,
    token_type: 'Bearer',
    expires_in: di.expires_in,
    expires_at: di.expires_at,
    scope: di.scope,
    __di: true,
    __di_client_id: di.client_id,
    __region: region,
  };
}

function looksLikeDiToken(token: any): token is DiOauth2Token {
  return !!token && token.__di === true && typeof token.__di_client_id === 'string';
}

/**
 * Replace the lib's `refreshOauth2Token` (which would call
 * `/oauth-service/oauth/exchange/user/2.0` via OAuth1, hitting the
 * 429-blocked path) with one that calls Garmin's DI refresh endpoint.
 *
 * Also fold native mobile headers into every connectapi request when the
 * stored token is a DI token. Garmin's connectapi accepts a DI Bearer
 * without the native headers in practice, but matching the official mobile
 * app's surface area (X-Garmin-User-Agent, X-Garmin-Client-Platform, …)
 * keeps us indistinguishable from a legitimate client and avoids whatever
 * heuristic eventually starts looking at the headers.
 */
function patchDiRefresh(httpClient: any): void {
  if (httpClient.__diRefreshPatched) return;
  httpClient.__diRefreshPatched = true;

  httpClient.refreshOauth2Token = async function (this: any) {
    const current = this.oauth2Token;
    if (!looksLikeDiToken(current) || !current.refresh_token) {
      throw new Error(
        'Stored Garmin session is missing DI refresh metadata; please reconnect Garmin',
      );
    }
    const refreshed = await refreshDiToken(
      current.__region,
      current.refresh_token,
      current.__di_client_id,
    );
    this.oauth2Token = toLibOauth2(refreshed, current.__region);
  };

  // Inject native headers on every authenticated request driven by this
  // client. The lib's own request interceptor (which sets `Authorization:
  // Bearer …`) runs first, so we just augment headers here.
  const axiosClient = httpClient.client;
  if (axiosClient && axiosClient.interceptors && !axiosClient.__diHeadersPatched) {
    axiosClient.__diHeadersPatched = true;
    axiosClient.interceptors.request.use(async (config: any) => {
      if (looksLikeDiToken(httpClient.oauth2Token)) {
        const extra = diApiHeaders();
        config.headers = { ...extra, ...config.headers };
      }
      return config;
    });
  }
}

/**
 * Exchange a Garmin service ticket (returned from the official SSO login
 * window) for a Garmin Digital Identity Bearer token, and persist it
 * encrypted under userId.
 *
 * The user never gives us their Garmin password — we only ever see the
 * post-login service ticket from the redirect.
 *
 * `serviceUrl` is the CAS service the ticket is bound to (the gauth-widget
 * sends it back alongside the ticket). The DI endpoint validates that
 * `service_url` matches the binding, so we forward whatever the frontend
 * captured. With our current frontend it'll be `sso.garmin.{cn,com}/sso/embed`.
 */
export async function authenticateWithBrowserTicket(
  userId: string,
  region: Region,
  ticket: string,
  serviceUrl: string | null = null,
): Promise<AuthenticatedClient> {
  const trimmed = String(ticket || '').trim();
  if (!trimmed) {
    throw new Error(`${getRegionLabel(region)}浏览器登录回调缺少 ticket`);
  }

  const client = buildClient(region);

  let oauth2Token: DiOauth2Token;
  try {
    const di = await exchangeServiceTicketForDi(region, trimmed, serviceUrl);
    oauth2Token = toLibOauth2(di, region);
  } catch (error) {
    throw new Error(humanizeAuthError(region, error));
  }

  client.loadToken(DI_OAUTH1_PLACEHOLDER, oauth2Token);
  patchDiRefresh(client.client);

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
  if (!looksLikeDiToken(session.oauth2)) {
    // Pre-DI sessions can no longer be refreshed (the OAuth1 path is
    // permanently 429-blocked on garmin.com and we don't want it on .cn
    // either). Drop the row so the user re-connects through DI.
    await clearGarminSession(userId, region);
    throw new Error(
      `${getRegionLabel(region)}本地会话来自旧的认证流程，请重新连接 Garmin`,
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
  patchDiRefresh(client.client);

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
