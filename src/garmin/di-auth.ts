/**
 * Garmin "DI" (Digital Identity) OAuth2 token exchange.
 *
 * Replaces the legacy `/oauth-service/oauth/preauthorized` → OAuth1 → OAuth2
 * exchange flow that `@gooin/garmin-connect` ships with. That flow uses a
 * single `oauth_consumer_key` (the public `fc3e99d2-…` from
 * thegarth.s3.amazonaws.com) shared by all open-source Garmin clients —
 * Garmin global aggressively 429s any request signed with that consumer
 * coming from a cloud-provider IP.
 *
 * The DI endpoint (`diauth.garmin.{cn,com}/di-oauth2-service/oauth/token`)
 * is the same one the official Garmin Connect mobile app uses, gated by
 * Bearer + native mobile headers, and is not subject to the same throttle.
 * Empirically: from the originai server, garmin.com preauthorized → 429,
 * garmin.com DI token endpoint → 400 "invalid service ticket" (i.e. the
 * request was processed, just the fake ticket was rejected).
 *
 * Reference implementation: cyberjunky/python-garminconnect
 *   garminconnect/client.py::_exchange_service_ticket / _refresh_di_token.
 */

import type { Region } from './store.js';

const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
] as const;

const DI_GRANT_TYPE =
  'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';

const NATIVE_USER_AGENT = 'GCM-Android-5.23';
const NATIVE_X_GARMIN_USER_AGENT =
  'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0';

function nativeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': NATIVE_USER_AGENT,
    'X-Garmin-User-Agent': NATIVE_X_GARMIN_USER_AGENT,
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

function basicAuth(clientId: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:`).toString('base64');
}

function diTokenUrl(region: Region): string {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com';
  return `https://diauth.${domain}/di-oauth2-service/oauth/token`;
}

function defaultServiceUrl(region: Region): string {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com';
  return `https://sso.${domain}/sso/embed`;
}

export interface DiTokenSet {
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  expires_at: number;
  scope: string | null;
  token_type: 'Bearer';
  client_id: string;
}

function buildTokenSet(payload: any, clientId: string): DiTokenSet {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = Number(payload.expires_in) || 3600;
  return {
    access_token: String(payload.access_token),
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    scope: payload.scope ? String(payload.scope) : null,
    token_type: 'Bearer',
    client_id: clientId,
  };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ status: number; ok: boolean; bodyText: string; json: any }> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const bodyText = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, bodyText, json };
}

/**
 * Exchange a CAS service ticket for a DI Bearer token. Tries each known
 * client_id in order — Garmin occasionally retires older ones.
 */
export async function exchangeServiceTicketForDi(
  region: Region,
  ticket: string,
  serviceUrl?: string | null,
): Promise<DiTokenSet> {
  const url = diTokenUrl(region);
  const svc = serviceUrl || defaultServiceUrl(region);
  const failures: string[] = [];

  for (const clientId of DI_CLIENT_IDS) {
    const res = await postForm(
      url,
      {
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: svc,
      },
      nativeHeaders({
        Authorization: basicAuth(clientId),
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      }),
    );

    if (res.status === 429) {
      throw new Error('HTTP Error (429): Too Many Requests');
    }
    if (res.ok && res.json?.access_token) {
      return buildTokenSet(res.json, clientId);
    }
    failures.push(
      `${clientId}: ${res.status} ${res.bodyText.slice(0, 200)}`,
    );
  }

  throw new Error(
    `DI token exchange failed for all client IDs. Last attempts: ${failures.join(' | ')}`,
  );
}

/**
 * Use a stored DI refresh token to get a fresh DI access token. Same endpoint
 * but `grant_type=refresh_token`.
 */
export async function refreshDiToken(
  region: Region,
  refreshToken: string,
  clientId: string,
): Promise<DiTokenSet> {
  const url = diTokenUrl(region);
  const res = await postForm(
    url,
    {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    },
    nativeHeaders({
      Authorization: basicAuth(clientId),
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    }),
  );
  if (!res.ok || !res.json?.access_token) {
    throw new Error(
      `DI token refresh failed: HTTP Error (${res.status}): ${res.bodyText.slice(0, 200)}`,
    );
  }
  // Garmin sometimes rotates refresh_token, sometimes not.
  const merged = { ...res.json, refresh_token: res.json.refresh_token || refreshToken };
  return buildTokenSet(merged, clientId);
}

/**
 * Native headers that should accompany every authenticated `connectapi.*`
 * request when using a DI Bearer token. Returned as a plain object so the
 * caller can fold them into axios defaults / interceptors.
 */
export function diApiHeaders(): Record<string, string> {
  return nativeHeaders({ Accept: 'application/json' });
}
