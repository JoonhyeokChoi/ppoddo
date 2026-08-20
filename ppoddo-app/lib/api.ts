// ---------------------------------------------------------------------------
// The only way this app talks to Cloud Run.
//
// Every backend call goes through apiFetch, which attaches the Supabase access
// token and handles the one recoverable failure (an expired token) in one
// place. Calling `fetch` against the API directly from a screen would work
// right up until the token rotated.
//
// Note what this file does NOT do: it never sends a user id. The backend takes
// the caller's identity from the token's `sub` claim, and a UUID in a request
// body would be a claim rather than evidence — see CLAUDE.md.
// ---------------------------------------------------------------------------

import { supabase } from './supabase';

export const API_BASE = 'https://ppoddo-api-214788185057.asia-northeast3.run.app';

/**
 * The backend's machine-readable error tags.
 *
 * Branch on these, never on the human-readable `error` string beside them —
 * that text is written for whoever is reading a log and is free to change.
 *
 * Three of them are the ones that matter, and they mean genuinely different
 * things despite two sharing a status code:
 *
 *   expired_token    401  the token aged out. Refresh and retry — handled below,
 *                         so no screen should ever see this.
 *   invalid_token    401  not our token, or not a token. Log in again.
 *   profile_required 403  signed in, but onboarding never finished. There is no
 *                         "onboarded" flag anywhere; the absence of the
 *                         public.users row IS the signal.
 *   not_a_member     403  signed in and onboarded, just not in that group.
 *
 * profile_required and not_a_member share 403 and must never be told apart by
 * status: one means "finish signing up", the other means "you were not invited".
 */
export type ApiErrorCode =
  | 'missing_token'
  | 'invalid_token'
  | 'expired_token'
  | 'profile_required'
  | 'not_a_member'
  | 'not_found'
  | 'jwks_unavailable'
  | 'database_unavailable'
  | 'internal_error'
  | 'no_session'
  | 'refresh_failed'
  | 'error';

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;

  constructor(status: number, message: string, code: ApiErrorCode = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** True when the user must be sent back to the login screen. */
export function isAuthFailure(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'invalid_token' || err.code === 'missing_token' ||
      err.code === 'no_session' || err.code === 'refresh_failed')
  );
}

/** True when the user is signed in but has not finished onboarding. */
export function needsOnboarding(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'profile_required';
}

/**
 * Read the token from the session on EVERY call, never from a cached variable.
 *
 * supabase-js rotates the access token on a background timer, so a copy taken
 * at login is correct for an hour and then silently wrong. The resulting 401s
 * arrive long after the code that caused them and read as a backend outage.
 *
 * getSession() is cheap — it reads the in-memory session, refreshing from
 * storage only when it has to — so there is no reason to hold onto the value.
 */
async function currentAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body from our own API means something upstream answered
    // instead — a proxy error page, say. Keep a slice of it: the status alone
    // would not say that.
    return { error: text.slice(0, 200), code: 'error' };
  }
}

/**
 * One backend call, authenticated.
 *
 * On a 401 the session is refreshed and the call retried exactly ONCE. Once,
 * not "until it works": if a fresh token is also rejected, the problem is not
 * expiry, and retrying would turn a broken session into a request loop against
 * our own backend. The same shape as the expired-signed-URL retry in the feed,
 * for the same reason.
 *
 * `init.body` must be a string (which every caller here uses). A stream body
 * could not be replayed on the retry.
 */
export async function apiFetch<T = any>(
  path: string,
  init: RequestInit = {},
  onEvent?: (message: string) => void,
): Promise<T> {
  const send = async (token: string) =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

  const token = await currentAccessToken();
  if (!token) throw new ApiError(401, '로그인이 필요합니다', 'no_session');

  let res = await send(token);

  if (res.status === 401) {
    onEvent?.('401 — 세션 갱신 후 한 번만 재시도');

    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) {
      // The refresh token itself is dead — revoked, already used, or from a
      // project that no longer recognises it. Nothing the app can do but start
      // over, and leaving the stale session in storage would make every
      // subsequent launch fail the same way.
      await supabase.auth.signOut();
      throw new ApiError(401, '세션이 만료되었습니다. 다시 로그인해 주세요', 'refresh_failed');
    }

    res = await send(data.session.access_token);

    if (res.status === 401) {
      // A brand-new token was rejected. That is not expiry: wrong issuer,
      // wrong audience, or a backend pointed at another Supabase project.
      // Signing out is right anyway — this session cannot be used here.
      const body = await parseBody(res);
      await supabase.auth.signOut();
      throw new ApiError(
        401,
        body?.error ?? '인증에 실패했습니다',
        (body?.code as ApiErrorCode) ?? 'invalid_token',
      );
    }
    onEvent?.('갱신 후 재시도 성공');
  }

  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error ?? `HTTP ${res.status}`,
      (body?.code as ApiErrorCode) ?? 'error',
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type Profile = { id: string; displayName: string };

/**
 * The profile, or null when onboarding has not happened yet.
 *
 * The 404 is translated to null here because at this one endpoint it is not an
 * error — it is the answer to the question being asked. Everywhere else a
 * missing profile arrives as a 403 profile_required, which IS an error.
 */
export async function getMe(onEvent?: (message: string) => void): Promise<Profile | null> {
  try {
    return await apiFetch<Profile>('/me', {}, onEvent);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Idempotent: calling it twice returns the existing row rather than failing. */
export async function createMe(
  displayName: string,
  onEvent?: (message: string) => void,
): Promise<Profile & { created: boolean }> {
  return apiFetch(
    '/me',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    },
    onEvent,
  );
}
