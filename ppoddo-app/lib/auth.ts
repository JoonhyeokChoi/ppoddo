// ---------------------------------------------------------------------------
// Google login.
//
// Google login only for now. Kakao web OAuth is blocked — Supabase forces the
// `account_email` scope, which Kakao only grants after 비즈 앱 전환 (verified
// 2026-08-06, KOE205). Kakao arrives in Phase 6 with the native SDKs, where the
// flow is signInWithIdToken and none of this applies.
//
// The OAuth client belongs to SUPABASE, not to the app. Google redirects to
// Supabase's /auth/v1/callback, Supabase completes the provider handshake, and
// only then does it redirect back here with a code. So there is no iOS OAuth
// client to create, no client secret on the device, and nothing to configure in
// Google Cloud for this step.
//
//   app  --(1)-->  Supabase authorize  --(2)-->  Google
//                                                  |
//   app  <--(4)--  Supabase callback   <--(3)-------+
//        ppoddo://auth/callback?code=...
//
// The provider token from step 3 is used by Supabase and then discarded. Every
// request this app makes to Cloud Run carries a SUPABASE JWT, never a Google
// one (CLAUDE.md, Auth and authorization).
// ---------------------------------------------------------------------------

import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabase';

/**
 * Where Supabase sends the browser once the provider handshake is done.
 *
 * Built from the `scheme` in app.json. It must be registered in Supabase under
 * Authentication -> URL Configuration -> Redirect URLs, exactly as printed —
 * Supabase matches redirect targets against that allow-list and silently
 * refuses anything else.
 *
 * The scheme lives in the native project (Info.plist / AndroidManifest), so
 * adding it to app.json only takes effect after a prebuild and a rebuild.
 */
export const REDIRECT_URL = makeRedirectUri({ scheme: 'ppoddo', path: 'auth/callback' });

/**
 * Reads one query parameter by hand instead of using `new URL(...).searchParams`.
 *
 * React Native's bundled URL is not the full WHATWG implementation and
 * `searchParams` cannot be relied on across versions. A missing accessor here
 * would surface as "no code in the redirect" — i.e. it would look exactly like
 * a broken OAuth flow, and the debugging would happen in the wrong place.
 */
function queryParam(url: string, name: string): string | null {
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

export type SignInResult =
  | { ok: true; session: Session }
  | { ok: false; stage: 'authorize' | 'browser' | 'exchange'; message: string; detail?: string };

/**
 * Runs the whole flow and reports WHICH STEP failed.
 *
 * The stage matters more than the message: the three ways this breaks —
 * unregistered scheme, missing redirect URL in Supabase, failed PKCE exchange —
 * all present as "login didn't work", and they are fixed in three different
 * places.
 */
export async function signInWithGoogle(
  log: (message: string, detail?: string) => void,
): Promise<SignInResult> {
  log(`redirect target: ${REDIRECT_URL}`);

  // 1. Ask Supabase for the provider URL. skipBrowserRedirect keeps the client
  //    from trying to navigate for us — there is no window to navigate in RN.
  //    This call also generates the PKCE verifier and stores it locally; the
  //    exchange below will not work without it, which is why both halves must
  //    happen in the same install.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true },
  });
  if (error || !data?.url) {
    return {
      ok: false,
      stage: 'authorize',
      message: 'Supabase가 로그인 주소를 만들지 못했습니다',
      detail: error?.message ?? 'no url returned',
    };
  }
  log('authorize url ready', data.url.slice(0, 80) + '…');

  // 2. openAuthSessionAsync, not openBrowserAsync: it knows to close itself and
  //    hand back the redirect when the URL matches REDIRECT_URL. openBrowserAsync
  //    would leave the browser sitting open with the app never hearing anything.
  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URL);
  log(`browser result: ${result.type}`);

  if (result.type !== 'success') {
    return {
      ok: false,
      stage: 'browser',
      // 'cancel' is the user backing out; 'dismiss' is usually the redirect not
      // coming back at all, which points at the scheme or the Supabase allow-list.
      message: result.type === 'cancel' ? '사용자가 취소했습니다' : '브라우저가 돌아오지 않았습니다',
      detail: result.type,
    };
  }

  // 3. Pull the authorization code out of the redirect. Supabase puts it in the
  //    query string for PKCE. If a URL comes back with `#access_token=...`
  //    instead, the client is running the implicit flow — flowType is not set to
  //    'pkce' — and there will be no code to exchange.
  const code = queryParam(result.url, 'code');
  if (!code) {
    const providerError =
      queryParam(result.url, 'error_description') ?? queryParam(result.url, 'error');
    return {
      ok: false,
      stage: 'exchange',
      message: providerError
        ? `공급자 오류: ${providerError}`
        : '돌아온 주소에 code 가 없습니다',
      detail: result.url.slice(0, 200),
    };
  }

  // 4. Trade the code plus the locally held verifier for a session. This is the
  //    step that proves the app started the flow — an intercepted code is
  //    useless without the verifier, which never left the device.
  const exchanged = await supabase.auth.exchangeCodeForSession(code);
  if (exchanged.error || !exchanged.data.session) {
    return {
      ok: false,
      stage: 'exchange',
      message: '코드를 세션으로 교환하지 못했습니다',
      detail: exchanged.error?.message ?? 'no session returned',
    };
  }

  log('session established');
  return { ok: true, session: exchanged.data.session };
}

export async function signOut(): Promise<string | null> {
  const { error } = await supabase.auth.signOut();
  return error?.message ?? null;
}

/** Rotates the tokens now, so refresh can be tested without waiting an hour. */
export async function forceRefresh(): Promise<{ session: Session | null; error: string | null }> {
  const { data, error } = await supabase.auth.refreshSession();
  return { session: data.session, error: error?.message ?? null };
}
