// ---------------------------------------------------------------------------
// TEMPORARY (Phase 2) — the login and profile test screen.
//
// Exists to answer these questions by hand, on a real device:
//   1. does Google login complete and produce a session
//   2. does that session survive killing and reopening the app
//   3. does the token actually refresh (not just "exists at startup")
//   4. does sign-out really clear it
//   5. does Cloud Run accept the token, and does it tell the three failure
//      states apart — bad token, no profile, not a member
//
// Question 3 is the one that hides. A session that loads from storage but
// cannot refresh looks perfectly healthy until the first expiry, an hour later,
// somewhere else entirely — so there is a button to force it now.
//
// The profile panel is what makes the onboarding signal visible. There is no
// "onboarded" flag: the existence of the public.users row IS the signal, so
// GET /me answering 404 is not a malfunction, it is the app being told to show
// onboarding.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './lib/supabase';
import { REDIRECT_URL, forceRefresh, signInWithGoogle, signOut } from './lib/auth';
import { ApiError, createMe, getMe, type Profile } from './lib/api';

type LogLine = { at: string; text: string; detail?: string; ok: boolean | null };

/** Wall clock plus seconds remaining, so expiry can be watched approaching. */
function describeExpiry(session: Session | null, now: number) {
  if (!session?.expires_at) return { text: '—', secondsLeft: null as number | null };
  // expires_at is in SECONDS since the epoch, not milliseconds. Treating it as
  // ms puts expiry in the year 56000 and every check silently passes.
  const expiresAtMs = session.expires_at * 1000;
  const secondsLeft = Math.round((expiresAtMs - now) / 1000);
  const clock = new Date(expiresAtMs).toLocaleTimeString('ko-KR', { hour12: false });
  return { text: clock, secondsLeft };
}

export default function AuthTestScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  // 'unknown' until /me has been called: distinct from 'none', which is the
  // verified answer "signed in, not onboarded". Collapsing the two would make
  // the screen claim onboarding is needed before it has asked.
  const [profileState, setProfileState] = useState<'unknown' | 'none' | 'ok'>('unknown');
  const [displayName, setDisplayName] = useState('');
  // Drives the countdown only; nothing else depends on it.
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  const log = useCallback((text: string, detail?: string, ok: boolean | null = null) => {
    const at = new Date().toISOString().slice(11, 19);
    setLines((prev) => [{ at, text, detail, ok }, ...prev].slice(0, 60));
    console.log(`[auth] ${text}${detail ? ` — ${detail}` : ''}`);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // One-time startup reporting. Guarded by a ref so a re-run does not spam the
  // log — safe to guard because this effect owns no subscription and has no
  // cleanup to undo.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    log(`redirect URL: ${REDIRECT_URL}`);

    // getSession() reads from AsyncStorage. Its result at startup is the whole
    // answer to "did persistence work" — if this is null after a cold start,
    // nothing else on this screen matters.
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) log('getSession 실패', error.message, false);
      else log(data.session ? '저장된 세션을 찾았습니다' : '저장된 세션 없음', undefined, !!data.session);
      setSession(data.session ?? null);
    });
  }, [log]);

  // The subscription gets its OWN effect, with no ref guard.
  //
  // Subscribe and unsubscribe must stay symmetric. A `if (done.current) return`
  // guard in front of a cleanup is unsound: React runs cleanup then setup again
  // on every Fast Refresh (and twice at mount under StrictMode), so the first
  // pass subscribes, the cleanup tears it down, and the guarded second pass
  // returns early without resubscribing. The listener is then gone for the rest
  // of the session while everything still looks fine — auth events simply stop
  // arriving, which reads as "login did nothing".
  useEffect(() => {
    // Every transition is logged by name. INITIAL_SESSION / SIGNED_IN /
    // SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED tell the story directly
    // instead of it having to be inferred from the panel.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      log(`onAuthStateChange: ${event}`, next?.user?.id?.slice(0, 8), true);
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, [log]);

  async function doSignIn() {
    setBusy('로그인 중…');
    try {
      const result = await signInWithGoogle((m, d) => log(m, d));
      if (result.ok) {
        // Set it directly from the call that returned it, rather than waiting
        // for SIGNED_IN to arrive. The listener should also fire, but the UI
        // must not depend on an event for a fact this function already holds —
        // that coupling is what made a dead listener look like a failed login.
        setSession(result.session);
        log('로그인 성공', result.session.user.email ?? undefined, true);
      }
      // The stage is printed because the three failure modes are fixed in three
      // different places — see the handoff notes.
      else log(`로그인 실패 [${result.stage}] ${result.message}`, result.detail, false);
    } catch (err: any) {
      log('로그인 중 예외', String(err?.message ?? err), false);
    } finally {
      setBusy(null);
    }
  }

  async function doRefresh() {
    setBusy('갱신 중…');
    try {
      const before = session?.access_token.slice(-8);
      const { session: next, error } = await forceRefresh();
      if (error) {
        log('갱신 실패', error, false);
        return;
      }
      const after = next?.access_token.slice(-8);
      // Comparing the token tails is the actual proof. A call that returns
      // without error but hands back the same token has not refreshed anything.
      log(
        after && after !== before ? '갱신됨 — 토큰이 바뀜' : '갱신했다지만 토큰이 그대로',
        `${before ?? '—'} → ${after ?? '—'}`,
        Boolean(after && after !== before),
      );
    } catch (err: any) {
      log('갱신 중 예외', String(err?.message ?? err), false);
    } finally {
      setBusy(null);
    }
  }

  async function doSignOut() {
    setBusy('로그아웃 중…');
    try {
      const error = await signOut();
      // Clear the cached profile too. Leaving it would show the previous user's
      // name over the next person's session — with six family members sharing
      // one household, that is a plausible thing to actually see.
      setProfile(null);
      setProfileState('unknown');
      log(error ? `로그아웃 실패: ${error}` : '로그아웃됨', undefined, !error);
    } finally {
      setBusy(null);
    }
  }

  /**
   * GET /me — the first call that proves the backend accepts our token.
   *
   * Three outcomes, and they are the whole point of this button:
   *   200  the token verified AND a profile row exists
   *   404  the token verified, there is no profile — show onboarding
   *   401  the token did not verify at all — a backend/issuer problem
   *
   * A 404 here is success for the auth work: it means the signature check, the
   * issuer check and the `sub` extraction all worked.
   */
  async function doGetMe() {
    setBusy('프로필 확인 중…');
    try {
      const me = await getMe((m) => log(m));
      if (me) {
        setProfile(me);
        setProfileState('ok');
        log('GET /me 200 — 프로필 있음', `${me.displayName} · ${me.id.slice(0, 8)}`, true);
      } else {
        setProfile(null);
        setProfileState('none');
        log('GET /me 404 — 프로필 없음 (온보딩 필요)', '토큰 검증은 성공', true);
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        log(`GET /me 실패 [${err.status} ${err.code}]`, err.message, false);
      } else {
        log('GET /me 예외', String(err?.message ?? err), false);
      }
    } finally {
      setBusy(null);
    }
  }

  /** POST /me — onboarding. Idempotent, so pressing it twice is harmless. */
  async function doCreateMe() {
    setBusy('프로필 만드는 중…');
    try {
      const me = await createMe(displayName.trim(), (m) => log(m));
      setProfile(me);
      setProfileState('ok');
      log(
        me.created ? 'POST /me 201 — 새로 만들어짐' : 'POST /me 200 — 이미 있음 (멱등)',
        `${me.displayName} · ${me.id.slice(0, 8)}`,
        true,
      );
    } catch (err: any) {
      if (err instanceof ApiError) {
        log(`POST /me 실패 [${err.status} ${err.code}]`, err.message, false);
      } else {
        log('POST /me 예외', String(err?.message ?? err), false);
      }
    } finally {
      setBusy(null);
    }
  }

  const expiry = describeExpiry(session, now);
  const provider = session?.user?.app_metadata?.provider ?? '—';

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.h1}>Phase 2 · 로그인 테스트</Text>

      <View style={styles.card}>
        <Row label="세션" value={session ? '있음' : '없음'} good={!!session} />
        <Row label="user id" value={session?.user?.id ?? '—'} />
        <Row label="email" value={session?.user?.email ?? '—'} />
        <Row label="provider" value={provider} />
        <Row label="만료 시각" value={expiry.text} />
        <Row
          label="남은 시간"
          value={expiry.secondsLeft === null ? '—' : `${expiry.secondsLeft}초`}
          good={expiry.secondsLeft === null ? undefined : expiry.secondsLeft > 0}
        />
        <Row label="access token 끝 8자" value={session?.access_token.slice(-8) ?? '—'} />
      </View>

      <View style={styles.gap} />
      <Button title="Google 로그인" onPress={doSignIn} disabled={busy !== null || !!session} />
      <View style={styles.gap} />
      <Button title="지금 갱신 (force refresh)" onPress={doRefresh} disabled={busy !== null || !session} />
      <View style={styles.gap} />
      <Button title="로그아웃" onPress={doSignOut} disabled={busy !== null || !session} />

      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.dim}>{busy}</Text>
        </View>
      )}

      <View style={styles.rule} />
      <Text style={styles.h2}>프로필 (온보딩)</Text>
      <View style={styles.card}>
        <Row
          label="상태"
          value={
            profileState === 'unknown'
              ? '확인 안 함'
              : profileState === 'ok'
                ? '있음 — 온보딩 완료'
                : '없음 — 온보딩 필요'
          }
          good={profileState === 'unknown' ? undefined : profileState === 'ok'}
        />
        <Row label="display_name" value={profile?.displayName ?? '—'} />
      </View>
      <View style={styles.gap} />
      <Button title="GET /me (프로필 확인)" onPress={doGetMe} disabled={busy !== null || !session} />
      <View style={styles.gap} />
      <TextInput
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="이름 (예: 준)"
        style={styles.input}
        autoCapitalize="none"
        editable={busy === null}
      />
      <View style={styles.gap} />
      <Button
        title="POST /me (프로필 만들기)"
        onPress={doCreateMe}
        disabled={busy !== null || !session || displayName.trim().length === 0}
      />

      <View style={styles.rule} />
      <Text style={styles.label}>등록해야 하는 redirect URL</Text>
      <Text style={styles.mono}>{REDIRECT_URL}</Text>

      <View style={styles.rule} />
      <Text style={styles.h2}>로그 (최신 순)</Text>
      {lines.length === 0 && <Text style={styles.dim}>—</Text>}
      {lines.map((line, i) => (
        <View key={i} style={styles.line}>
          <Text style={styles.mono}>
            <Text style={styles.dim}>{line.at} </Text>
            <Text style={line.ok === false ? styles.bad : line.ok ? styles.good : styles.warn}>
              {line.ok === false ? '✕' : line.ok ? '✓' : '·'}
            </Text>{' '}
            {line.text}
          </Text>
          {line.detail ? <Text style={styles.detail}>{line.detail}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, good === true && styles.good, good === false && styles.bad]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingTop: 16, paddingBottom: 48 },
  h1: { fontSize: 20, fontWeight: '600', marginBottom: 12 },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 6 },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { fontSize: 12, color: '#666' },
  rowValue: { fontSize: 12, fontFamily: mono, flexShrink: 1 },
  label: { fontSize: 12, color: '#666', marginBottom: 4 },
  dim: { fontSize: 12, color: '#777' },
  mono: { fontFamily: mono, fontSize: 11 },
  detail: { fontFamily: mono, fontSize: 10, color: '#777', marginLeft: 14 },
  good: { color: '#1a7f37' },
  bad: { color: '#c0392b' },
  warn: { color: '#b8860b' },
  rule: { height: 1, backgroundColor: '#ddd', marginVertical: 14 },
  gap: { height: 8 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  line: { paddingVertical: 2 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
