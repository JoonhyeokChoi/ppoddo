// ---------------------------------------------------------------------------
// TEMPORARY (Phase 1) — the vertical slice screen.
//
// One photo: phone -> Cloud Run -> GCS -> back on screen. No upload queue, no
// calendar. As of Phase 2 every call here is authenticated: the caller is the
// signed-in user from the Supabase JWT, not a constant. The group is still
// hardcoded only because there is no group picker until Phase 3 — and the
// signed-in user must actually be a member of it, which is a real check now.
//
// This file is thrown away in Phase 4, when the real upload flow arrives with a
// local queue that survives cold start and a visible failure state. Nothing
// here is a pattern to copy forward except the two things it exists to prove:
// the FileSystem.uploadAsync PUT and the expired-URL retry.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import {
  uploadAsync,
  getInfoAsync,
  FileSystemUploadType,
} from 'expo-file-system/legacy';

import AuthTestScreen from './AuthTestScreen';
import { supabase } from './lib/supabase';
import { ApiError, apiFetch, isAuthFailure, needsOnboarding } from './lib/api';

import expoPkg from 'expo/package.json';
import fsPkg from 'expo-file-system/package.json';
import imagePkg from 'expo-image/package.json';

/** The backend's Phase 1 seed group. Replaced by a real group list in Phase 3. */
const GROUP_ID = '11111111-1111-1111-1111-111111111111';

/**
 * MUST match the Content-Type the URL was signed with, byte for byte. The value
 * is part of the signed string (X-Goog-SignedHeaders=content-type;host), so a
 * mismatch is a 403 SignatureDoesNotMatch — it reads like an auth failure even
 * though it is a header problem.
 */
const CONTENT_TYPE = 'image/jpeg';

type MediaItem = { mediaId: string; kind: string; url: string };

type LogLine = {
  at: string;
  tag: string;
  text: string;
  ok: boolean | null;
};

/**
 * The calendar day in KST, matching how the backend computes posted_on. Deriving
 * it from the device's local date would put a traveller — or anyone whose phone
 * is on UTC — on the wrong day and show them an empty feed.
 */
function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * GCS answers an expired signed URL and a bad one with different statuses, and
 * only one of them is worth refetching for. Measured 2026-08-13 against the real
 * bucket:
 *
 *   expired signature   -> 400 <Code>ExpiredToken</Code>
 *   altered signature   -> 403 <Code>SignatureDoesNotMatch</Code>
 *   no signature at all -> 403 <Code>AccessDenied</Code>
 *
 * So the expiry case — the one this whole path exists for — is a 400, not a 403.
 * Both are retried exactly once: the 403s are cheap to attempt and a stale
 * membership is a real (if unlikely) cause, and the retry-once rule stops either
 * from looping.
 */
function isRetryable(status: number): boolean {
  return status === 400 || status === 403;
}

/**
 * A short stand-in for "which signed URL is this", so the log can show that the
 * URL changed while the load still came from cache — which is the whole proof
 * that caching is keyed on the media id and not on the URL.
 *
 * X-Goog-Date plus a slice of the signature is enough: both change on every
 * mint, and neither is secret in a log the tester is already holding.
 */
function urlFingerprint(url: string): string {
  const date = /X-Goog-Date=([^&]+)/.exec(url)?.[1] ?? '?';
  const sig = /X-Goog-Signature=([^&]{0,6})/.exec(url)?.[1] ?? '?';
  return `${date}·${sig}`;
}

/**
 * TEMPORARY (Phase 1). Alters one character of the v4 signature so GCS answers
 * 403 SignatureDoesNotMatch — every time, no matter how often the URL is
 * reminted.
 *
 * This exists to test the ONE Phase 1 behaviour that success can never
 * exercise: the bound on retrying. Every retry observed so far succeeded on the
 * second attempt, so the "stop after one retry" rule has never actually had to
 * stop anything. If it is wrong, the symptom is an unbounded request loop
 * against GCS — invisible while URLs keep working, and ugly the day one
 * doesn't.
 *
 * The signature is hex, so flipping a hex digit keeps the URL well-formed and
 * fails at exactly the intended layer: verification, not parsing. Corrupting
 * the path instead would also 403, but as AccessDenied on a nonexistent object,
 * which is a different failure than the one being modelled.
 */
function corruptSignature(url: string): string {
  const match = /X-Goog-Signature=([0-9a-fA-F]+)/.exec(url);
  if (!match) return url;
  const signature = match[1];
  const i = Math.min(8, signature.length - 1);
  const flipped =
    signature.slice(0, i) + (signature[i].toLowerCase() === 'a' ? 'b' : 'a') + signature.slice(i + 1);
  return url.replace(signature, flipped);
}

/** TEMPORARY (Phase 1). Per-item evidence for the retry-bound assertions. */
type Stat = {
  loadAttempts: number; // every onLoad + onError the item reported
  refetchesRequested: number; // times THIS item asked for a fresh list
  failures: string[]; // "403 SignatureDoesNotMatch" per probe
  outcome: 'pending' | 'loaded' | 'failed';
};

/**
 * TEMPORARY (Phase 1). When true the retry-bound scenario runs by itself on
 * launch and prints its counters, so the measurement does not depend on taps
 * landing in the right order. Leave false for ordinary use of the screen.
 */
const AUTO_TEST = false;

const EMPTY_STAT: Stat = {
  loadAttempts: 0,
  refetchesRequested: 0,
  failures: [],
  outcome: 'pending',
};

/**
 * TEMPORARY. Two test screens live side by side while Phase 2 is built: the
 * Phase 1 vertical slice (still the only thing that proves upload and the retry
 * bound) and the Phase 2 login screen. Both are thrown away in Phase 4.
 */
export default function App() {
  const [tab, setTab] = useState<'phase1' | 'auth'>('auth');

  // Losing the session must return to the login screen, wherever the user
  // happens to be standing. apiFetch signs out when a refreshed token is still
  // rejected, and that can happen deep inside the upload flow — so the switch
  // has to be driven by the auth state itself rather than by each call site
  // remembering to navigate.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) setTab('auth');
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.tabs}>
        {(
          [
            ['auth', 'Phase 2 · 로그인'],
            ['phase1', 'Phase 1 · 업로드'],
          ] as const
        ).map(([key, title]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={[styles.tab, tab === key && styles.tabOn]}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextOn]}>{title}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'auth' ? <AuthTestScreen /> : <Phase1Screen />}
    </View>
  );
}

function Phase1Screen() {
  const [busy, setBusy] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  // TEMPORARY (Phase 1). Bumped to force the image views to remount and go back
  // to the network — see forceStaleReload below.
  const [renderNonce, setRenderNonce] = useState(0);
  const date = kstToday();

  // Retries are tracked in a ref, not state: onError fires from the native image
  // component and must read the CURRENT value, not the one captured when the
  // element rendered. A state read there would see a stale closure and allow a
  // second retry.
  const retried = useRef<Set<string>>(new Set());
  // Guards against N images all 403ing at once and firing N identical refetches.
  const refetching = useRef<Promise<MediaItem[]> | null>(null);
  // media id -> fingerprint of the URL used the last time this item loaded.
  // Lets onLoad say whether the URL changed since the previous load, which is
  // what makes a cache hit meaningful rather than a coincidence.
  const lastUrl = useRef<Map<string, string>>(new Map());

  // ---- TEMPORARY (Phase 1): retry-bound test instrumentation ----
  const [corrupt, setCorrupt] = useState(false);
  // Mirrored into a ref because fetchFeed and the error handler run from async
  // callbacks that would otherwise read the value captured at render time.
  const corruptRef = useRef(false);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  // Items that have exhausted their one retry. Rendered as a failed tile
  // instead of an <Image>, which is both the visible failure state and the
  // thing that stops a remount from starting the cycle again.
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());
  // Counts only the refetches actually SENT, so several items failing together
  // can be told apart from several requests going out.
  const refetchesSent = useRef(0);

  // The ref is the source of truth; the state is only a mirror for rendering.
  // The report runs from inside a long-lived async sequence, where a state read
  // would return the value captured when that sequence started — which for a
  // test whose whole output is counters would silently under-report.
  const statsRef = useRef<Record<string, Stat>>({});
  const bump = useCallback((mediaId: string, patch: (s: Stat) => Stat) => {
    statsRef.current = {
      ...statsRef.current,
      [mediaId]: patch(statsRef.current[mediaId] ?? EMPTY_STAT),
    };
    setStats(statsRef.current);
  }, []);

  const log = useCallback((tag: string, text: string, ok: boolean | null = null) => {
    const at = new Date().toISOString().slice(11, 19);
    setLines((prev) => [{ at, tag, text, ok }, ...prev].slice(0, 60));
    console.log(`[${tag}] ${text}`);
  }, []);

  /**
   * Names the three auth outcomes rather than printing a status.
   *
   * 403 profile_required and 403 not_a_member are the same status and mean
   * opposite things — "you have not finished signing up" versus "you were not
   * invited to this group" — so a log line reading "403" would be the least
   * useful possible thing to see while testing.
   */
  const logApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        const explanation = needsOnboarding(err)
          ? '프로필 없음 → 온보딩 필요'
          : err.code === 'not_a_member'
            ? '이 그룹의 멤버가 아님'
            : isAuthFailure(err)
              ? '인증 실패 → 다시 로그인'
              : err.code;
        log('api', `${err.status} ${err.code} — ${explanation}`, false);
        return;
      }
      log('error', String((err as any)?.message ?? err), false);
    },
    [log],
  );

  useEffect(() => {
    log('versions', `expo ${expoPkg.version} · image ${imagePkg.version} · fs ${fsPkg.version} · ${Platform.OS}`);
  }, [log]);

  /** GET the day's feed. Returns the items so callers can use them immediately. */
  const fetchFeed = useCallback(
    async (tag: string): Promise<MediaItem[]> => {
      const started = Date.now();
      // The expiry is no longer selectable. ?expiresInSeconds was deleted from
      // the backend along with the debug routes: with auth in place, letting a
      // caller choose the lifetime means letting it choose how long a leaked
      // bearer credential stays live. Every URL below is the production 15
      // minutes.
      const body = await apiFetch<{ items: MediaItem[] }>(
        `/groups/${GROUP_ID}/dates/${date}/media`,
        {},
        (m) => log('auth', m, null),
      );
      // TEMPORARY (Phase 1). Every list response passes through here — the first
      // one and every refetch — so corrupting at this single point is what makes
      // the failure PERSISTENT. Corrupting only the initial response would let
      // the retry succeed and the scenario would never reproduce.
      const received: MediaItem[] = corruptRef.current
        ? body.items.map((item: MediaItem) => ({ ...item, url: corruptSignature(item.url) }))
        : body.items;

      log(
        tag,
        `${received.length}장 · 만료 900s · ${Date.now() - started}ms` +
          (corruptRef.current ? ' · 서명 손상시킴' : ''),
        true,
      );
      setItems(received);
      // Remount the image views on every list response. Without this, expo-image
      // may see the same cacheKey and skip the load entirely — no onLoad, no log
      // line, and the cache test reports nothing at all. Remounting forces a real
      // attempt with the newly minted URL, which is exactly the comparison the
      // cache log is trying to make.
      setRenderNonce((n) => n + 1);
      return body.items;
    },
    [date, log],
  );

  // ---- steps 1-5: pick, create row, PUT bytes, complete, list ----
  async function pickAndUpload() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        log('pick', '사진 권한이 없습니다', false);
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        exif: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];

      const info = await getInfoAsync(asset.uri);
      const size = info.exists && !info.isDirectory ? info.size : null;
      log('pick', `${asset.uri.split('/').pop()} · ${size ?? '?'} bytes`, true);

      // 1. Create the row and get a signed PUT url. The row exists before any
      //    bytes move, so an orphan object cannot happen.
      setBusy('업로드 준비 중…');
      let started = Date.now();
      const created = await apiFetch<{ mediaId: string; uploadUrl: string }>(
        '/uploads',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'photo',
            contentType: CONTENT_TYPE,
            groupIds: [GROUP_ID],
          }),
        },
        (m) => log('auth', m, null),
      );
      log('POST /uploads', `${created.mediaId} · ${Date.now() - started}ms`, true);

      // 2. PUT the bytes straight to GCS. Never through Cloud Run.
      //    uploadAsync streams from disk; fetch+Blob sends an empty Content-Type
      //    and fails the signature check with a 403 (verified 2026-08-07).
      setBusy('사진 올리는 중…');
      started = Date.now();
      const put = await uploadAsync(created.uploadUrl, asset.uri, {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': CONTENT_TYPE },
      });
      if (put.status !== 200) throw new Error(`PUT ${put.status}: ${(put.body ?? '').slice(0, 200)}`);
      log('PUT → GCS', `200 · ${size ?? '?'} bytes · ${Date.now() - started}ms`, true);

      // 3. Flip pending -> ready. Until this lands the feed will not show it.
      setBusy('마무리 중…');
      started = Date.now();
      const done = await apiFetch<{ status: string; changed: boolean }>(
        `/uploads/${created.mediaId}/complete`,
        { method: 'POST' },
        (m) => log('auth', m, null),
      );
      log('complete', `status=${done.status} changed=${done.changed} · ${Date.now() - started}ms`, true);

      // 4. Reload the feed.
      setBusy('불러오는 중…');
      retried.current.clear();
      await fetchFeed('GET feed');
    } catch (err: any) {
      logApiError(err);
    } finally {
      setBusy(null);
    }
  }

  async function reloadFeed() {
    setBusy('불러오는 중…');
    try {
      retried.current.clear();
      await fetchFeed('GET feed');
    } catch (err: any) {
      logApiError(err);
    } finally {
      setBusy(null);
    }
  }

  /**
   * TEMPORARY (Phase 1). The only way to actually reach the retry path.
   *
   * Picking a 10s expiry is not enough on its own: the images load instantly
   * while the URL is still valid, and expo-image then serves them from its cache
   * under the media id forever after. Reloading the feed does not help either —
   * that mints brand new URLs, so nothing stale is ever requested.
   *
   * So: drop the caches, keep the URLs already in state, and force the image
   * views to remount. They go back to the network with the now-expired URLs,
   * which is exactly the situation a grandparent hits after leaving the app open
   * on the sofa for twenty minutes.
   */
  async function forceStaleReload() {
    setBusy('캐시 비우는 중…');
    try {
      await Image.clearMemoryCache();
      await Image.clearDiskCache();
      retried.current.clear();
      // Both caches are gone, so the next load is legitimately a network fetch.
      // Forgetting the fingerprints keeps that from being reported as a cacheKey
      // failure — it would be a false alarm in the one test that deliberately
      // empties the cache.
      lastUrl.current.clear();
      setRenderNonce((n) => n + 1);
      log('test', '캐시 비움 — 기존(만료된) URL 로 다시 그립니다', null);
    } catch (err: any) {
      log('error', String(err?.message ?? err), false);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Did the cacheKey actually do anything?
   *
   * expo-image reports where the bytes came from: 'none' means it went to the
   * network, 'memory' / 'disk' mean it did not. On its own that is not proof of
   * anything — an unchanged URL would hit a URL-keyed cache just as well. The
   * proof is the combination:
   *
   *   URL changed  +  cacheType memory/disk  ->  keyed on the media id.  PASS
   *   URL changed  +  cacheType none         ->  keyed on the URL. Every list
   *                                              request re-downloads bytes the
   *                                              phone already has.           FAIL
   *
   * That failure is the expensive one and it is completely silent: the feed
   * still renders correctly, it is just slower and paying egress every time.
   */
  const handleImageLoad = useCallback(
    (item: MediaItem, cacheType: 'none' | 'disk' | 'memory') => {
      const id8 = item.mediaId.slice(0, 8);
      const fingerprint = urlFingerprint(item.url);
      const previous = lastUrl.current.get(item.mediaId);
      lastUrl.current.set(item.mediaId, fingerprint);
      bump(item.mediaId, (s) => ({
        ...s,
        loadAttempts: s.loadAttempts + 1,
        outcome: 'loaded',
      }));

      const source = cacheType === 'none' ? '네트워크' : `캐시(${cacheType})`;

      if (previous === undefined) {
        // Nothing to compare against yet. A network fetch here is correct.
        log('cache', `${id8} ${source} · 첫 로드 · ${fingerprint}`, null);
        return;
      }
      if (previous === fingerprint) {
        // Same URL, so a hit proves nothing about the cacheKey either way.
        log('cache', `${id8} ${source} · URL 그대로 (판정 불가)`, null);
        return;
      }
      log(
        'cache',
        cacheType === 'none'
          ? `${id8} ${source} · URL 바뀜 → 재다운로드. cacheKey 동작 안 함`
          : `${id8} ${source} · URL 바뀌었는데 적중 → cacheKey 동작함`,
        cacheType !== 'none',

      );
    },
    [log],
  );

  /**
   * TEMPORARY (Phase 1). Remount with everything left alone — same URLs, both
   * caches warm.
   *
   * This is the control that separates the two reasons a load can miss memory
   * and fall through to disk:
   *
   *   캐시(memory) · URL 그대로  -> the memory cache works and is keyed on the
   *                               URL, so a newly minted URL always misses it
   *                               and only the disk cache honours cacheKey.
   *   캐시(disk)   · URL 그대로  -> the memory cache is not retaining across a
   *                               remount at all, and the render nonce is what
   *                               costs us the memory hit.
   *
   * Either way nothing re-downloads, so this is a performance question (a disk
   * read and decode per render) rather than a correctness or egress one.
   */
  function redrawOnly() {
    setRenderNonce((n) => n + 1);
    log('test', '캐시 그대로 다시 그리기 — memory 가 찍히면 메모리 캐시는 URL 기준', null);
  }

  /**
   * TEMPORARY (Phase 1). Clears the MEMORY cache only, then remounts.
   *
   * Separating the two caches matters because they answer different questions.
   * A memory hit only proves caching works within one run of the app; the disk
   * cache is what makes the feed fast after the app is killed and reopened,
   * which is how grandparents actually use it. Clear memory, reload, and a
   * cacheType of 'disk' says the disk cache is keyed on the media id too.
   */
  async function clearMemoryOnly() {
    setBusy('메모리 캐시 비우는 중…');
    try {
      await Image.clearMemoryCache();
      setRenderNonce((n) => n + 1);
      log('test', '메모리 캐시만 비움 — 다음 로드는 disk 여야 정상', null);
    } catch (err: any) {
      log('error', String(err?.message ?? err), false);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Terminal failure for one item.
   *
   * Both a UI state and a latch. As UI it is the requirement that a failure is
   * *visible*: a grandparent must see that something went wrong rather than a
   * spinner that never resolves, because a photo that simply never arrives is
   * indistinguishable from no photo having been sent.
   *
   * As a latch it is what stops the cycle permanently — the failed tile renders
   * instead of an <Image>, so there is nothing left to fire onError again.
   */
  const markFailed = useCallback(
    (mediaId: string, why: string) => {
      failedRef.current.add(mediaId);
      setFailed(new Set(failedRef.current));
      bump(mediaId, (s) => ({ ...s, outcome: 'failed' }));
      log('load', `${mediaId.slice(0, 8)} ${why}`, false);
    },
    [bump, log],
  );

  /** TEMPORARY (Phase 1). Dumps the per-item counters and checks the bounds. */
  const report = useCallback(
    (label: string) => {
      const entries = Object.entries(statsRef.current);
      console.log(`\n===== 재시도 한계 리포트: ${label} =====`);
      console.log(`실제 발송된 목록 재요청 (전체): ${refetchesSent.current}`);
      for (const [mediaId, s] of entries) {
        console.log(
          `  ${mediaId.slice(0, 8)}  로드시도 ${s.loadAttempts}  재요청요청 ${s.refetchesRequested}` +
            `  결과 ${s.outcome}  실패 [${s.failures.join(', ') || '-'}]`,
        );
      }
      const failing = entries.filter(([, s]) => s.outcome === 'failed');
      if (failing.length) {
        const attemptsOk = failing.every(([, s]) => s.loadAttempts === 2);
        const perItemOk = failing.every(([, s]) => s.refetchesRequested === 1);
        const sharedOk = refetchesSent.current === 1;
        console.log(
          `  판정: 로드 2회 ${attemptsOk ? 'PASS' : 'FAIL'} · 항목당 재요청 1회 ` +
            `${perItemOk ? 'PASS' : 'FAIL'} · 공유 재요청 1건 ${sharedOk ? 'PASS' : 'FAIL'}`,
        );
      }
      console.log('==========================================\n');
      log('report', `${label} · 발송된 재요청 ${refetchesSent.current}건`, null);
    },
    [log],
  );

  /** TEMPORARY (Phase 1). Clean slate so a run's counters mean only that run. */
  const resetTest = useCallback(() => {
    statsRef.current = {};
    setStats({});
    failedRef.current = new Set();
    setFailed(new Set());
    retried.current.clear();
    lastUrl.current.clear();
    refetchesSent.current = 0;
  }, []);

  /**
   * TEMPORARY (Phase 1). Runs the persistent-failure scenario.
   *
   * Clearing both caches first is not tidiness — it is load-bearing. cacheKey is
   * the media id, so a warm disk cache serves the image without ever touching
   * the corrupted URL, and the failure simply would not reproduce. The caches
   * have to be empty for the URL to matter at all.
   */
  const runCorruptTest = useCallback(async () => {
    setBusy('손상 테스트 준비 중…');
    try {
      corruptRef.current = true;
      setCorrupt(true);
      resetTest();
      await Image.clearMemoryCache();
      await Image.clearDiskCache();
      log('test', '서명 손상 ON · 캐시 비움 — 모든 이미지가 403 이어야 함', null);
      await fetchFeed('GET feed (손상 테스트)');
    } catch (err: any) {
      logApiError(err);
    } finally {
      setBusy(null);
    }
  }, [fetchFeed, log, logApiError, resetTest]);

  // ---- Part C: the expired-URL retry ----
  //
  // Reactive only. No timer, no refresh-before-expiry: a foreground refresh
  // would mint URLs nobody looks at and still lose the race on a backgrounded
  // phone. Attempt, fail, refetch once.
  const handleImageError = useCallback(
    async (item: MediaItem, message: string) => {
      const id8 = item.mediaId.slice(0, 8);
      bump(item.mediaId, (s) => ({ ...s, loadAttempts: s.loadAttempts + 1 }));

      // Terminal state, checked before anything else. An item that has already
      // spent its retry must not start the cycle over just because its view was
      // recreated — FlatList recycles views while scrolling, so an
      // unmount-driven reset would rebuild the exact loop this bound exists to
      // prevent, only slower and harder to spot.
      if (failedRef.current.has(item.mediaId)) {
        log('load', `${id8} 이미 실패 처리됨 — 아무것도 하지 않음`, false);
        return;
      }

      if (retried.current.has(item.mediaId)) {
        // Second failure. This is a permissions problem or an outage, not
        // expiry. Stopping here is the point — refetching on every error turns
        // one 403 into an unbounded request loop against our own backend.
        markFailed(item.mediaId, `2차 실패 — 중단 (${message})`);
        return;
      }
      retried.current.add(item.mediaId);

      // expo-image's onError gives a message, not a status code, and the wording
      // differs between the iOS and Android decoders. So ask GCS directly what
      // happened rather than pattern-matching a string that a library update can
      // reword. Range: bytes=0-0 keeps the probe to one byte instead of
      // re-downloading the image just to read its status.
      let status = 0;
      let code = '';
      try {
        const probe = await fetch(item.url, { headers: { Range: 'bytes=0-0' } });
        status = probe.status;
        if (!probe.ok) code = (await probe.text()).match(/<Code>([^<]+)</)?.[1] ?? '';
      } catch (err: any) {
        markFailed(item.mediaId, `진단 실패: ${err?.message}`);
        return;
      }
      bump(item.mediaId, (s) => ({ ...s, failures: [...s.failures, `${status} ${code}`] }));

      if (!isRetryable(status)) {
        markFailed(item.mediaId, `${status} ${code} — 재시도 안 함`);
        return;
      }
      log('load', `${id8} ${status} ${code} → 목록 다시 요청`, null);
      bump(item.mediaId, (s) => ({ ...s, refetchesRequested: s.refetchesRequested + 1 }));

      try {
        // Refetching the LIST, not the URL — that is what re-runs the membership
        // check on the backend. A URL-only refresh would hand out access to
        // someone who was removed from the group since the first request.
        //
        // Always at the production expiry: the short test expiry is for
        // provoking the failure, and reusing it here would expire the retry too.
        if (!refetching.current) {
          refetchesSent.current += 1;
          log('refetch', `실제 발송 #${refetchesSent.current} (${id8} 이 요청)`, null);
          refetching.current = fetchFeed('GET feed (재요청)').finally(() => {
            refetching.current = null;
          });
        } else {
          log('refetch', `${id8} 진행 중인 요청에 합류 (발송 안 함)`, null);
        }
        const fresh = await refetching.current;
        const replacement = fresh.find((i) => i.mediaId === item.mediaId);
        if (!replacement) {
          markFailed(item.mediaId, '목록에서 사라짐 (삭제됨?)');
          return;
        }
        log('load', `${id8} 새 URL 로 재시도`, null);
      } catch (err: any) {
        markFailed(item.mediaId, `재요청 실패: ${err?.message}`);
      }
    },
    [bump, fetchFeed, log, markFailed],
  );

  // TEMPORARY (Phase 1). Runs the whole scenario unattended so the counters come
  // from a real device rather than from someone tapping in the right order.
  const auto = useRef(false);
  useEffect(() => {
    if (!AUTO_TEST || auto.current) return;
    auto.current = true;
    (async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await wait(1500);
      await runCorruptTest();
      await wait(12000);
      report('초기 로드');
      // Assertion 3: a remount must not restart the cycle for a failed item.
      log('test', '리마운트 — 실패한 항목이 다시 시도하면 안 됨', null);
      setRenderNonce((n) => n + 1);
      await wait(8000);
      report('리마운트 후');
    })();
  }, [log, report, runCorruptTest]);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>뽀또 Phase 1</Text>
        <Text style={styles.dim}>
          {date} (KST) · group {GROUP_ID.slice(0, 8)}…
        </Text>

        <View style={styles.rule} />

        <Button title="사진 고르고 올리기" onPress={pickAndUpload} disabled={busy !== null} />
        <View style={styles.gap} />
        <Button title="다시 불러오기" onPress={reloadFeed} disabled={busy !== null} />

        {busy !== null && (
          <View style={styles.busy}>
            <ActivityIndicator />
            <Text style={styles.dim}>{busy}</Text>
          </View>
        )}

        <View style={styles.rule} />

        <Text style={styles.label}>만료 테스트</Text>
        <Button
          title="만료 테스트: 캐시 비우고 다시 그리기"
          onPress={forceStaleReload}
          disabled={busy !== null || items.length === 0}
        />
        <Text style={styles.dim}>
          URL 만료는 이제 항상 15분으로 고정입니다 (?expiresInSeconds 삭제됨). 이 버튼은 15분
          이상 지난 뒤에 눌러야 만료 경로를 탑니다. 짧은 만료로 빠르게 확인하려면 아래 "서명
          손상" 테스트를 쓰세요 — 재시도 경로는 같습니다.
        </Text>

        <View style={styles.rule} />

        <Text style={styles.label}>캐시 테스트</Text>
        <Button
          title="그대로 다시 그리기 (URL·캐시 유지)"
          onPress={redrawOnly}
          disabled={busy !== null || items.length === 0}
        />
        <View style={styles.gap} />
        <Button
          title="메모리 캐시만 비우기 (디스크 캐시 확인)"
          onPress={clearMemoryOnly}
          disabled={busy !== null || items.length === 0}
        />
        <Text style={styles.dim}>
          "다시 불러오기" 를 누르면 URL 이 새로 발급됩니다. 그때도 로그에 캐시(memory) 가
          찍히면 media ID 로 캐시되고 있다는 뜻입니다.
        </Text>

        <View style={styles.rule} />

        <View style={styles.rule} />

        {/* TEMPORARY (Phase 1) retry-bound test. */}
        <Text style={styles.label}>재시도 한계 테스트</Text>
        <Button
          title={corrupt ? '서명 손상 ON — 다시 실행' : '서명 손상시켜 실패 재현'}
          onPress={runCorruptTest}
          disabled={busy !== null}
        />
        <View style={styles.gap} />
        <Button title="카운터 출력" onPress={() => report('수동')} disabled={busy !== null} />
        <Text style={styles.dim}>
          발송된 목록 재요청: {refetchesSent.current}건 · 실패 처리된 항목: {failed.size}개
        </Text>

        <View style={styles.rule} />

        <Text style={styles.h2}>피드 ({items.length})</Text>
        <View style={styles.grid}>
          {items.map((item) =>
            // A failed item renders as a failed tile, never as an <Image>. That
            // is the visible failure state, and it is also what makes the stop
            // permanent: with no image view there is nothing left to retry.
            failed.has(item.mediaId) ? (
              <View key={item.mediaId} style={[styles.thumb, styles.thumbFailed]}>
                <Text style={styles.failMark}>✕</Text>
                <Text style={styles.failText}>불러오기 실패</Text>
                <Text style={styles.failText}>
                  시도 {stats[item.mediaId]?.loadAttempts ?? 0}회
                </Text>
              </View>
            ) : (
              <Image
                key={`${item.mediaId}:${renderNonce}`}
                // cacheKey is keyed on the media id, never the URL. Signed URLs
                // change on every list request, so a URL-keyed cache would miss
                // every single time and re-download bytes the phone already has.
                source={{ uri: item.url, cacheKey: item.mediaId }}
                style={styles.thumb}
                contentFit="cover"
                onLoad={(e) => handleImageLoad(item, e.cacheType)}
                onError={(e) => handleImageError(item, e?.error ?? 'unknown')}
              />
            ),
          )}
          {items.length === 0 && <Text style={styles.dim}>아직 사진이 없습니다</Text>}
        </View>

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
              <Text style={styles.tag}>{line.tag}</Text> {line.text}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 64, paddingBottom: 8 },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  tabOn: { backgroundColor: '#111', borderColor: '#111' },
  tabText: { fontSize: 13, color: '#333' },
  tabTextOn: { color: '#fff' },
  // paddingTop is small because the tab bar above already clears the notch.
  scroll: { padding: 16, paddingTop: 8, gap: 4, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: '600' },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 6 },
  label: { marginTop: 4, marginBottom: 6, fontSize: 12, color: '#666' },
  dim: { fontSize: 12, color: '#777' },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  tag: { fontWeight: '600' },
  good: { color: '#1a7f37' },
  bad: { color: '#c0392b' },
  warn: { color: '#b8860b' },
  rule: { height: 1, backgroundColor: '#ddd', marginVertical: 14 },
  gap: { height: 8 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  chipOn: { backgroundColor: '#111', borderColor: '#111' },
  chipText: { fontSize: 13, color: '#333' },
  chipTextOn: { color: '#fff' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { width: 104, height: 104, borderRadius: 8, backgroundColor: '#eee' },
  thumbFailed: {
    borderWidth: 1,
    borderColor: '#e0b4ad',
    backgroundColor: '#fdf0ee',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  failMark: { fontSize: 20, color: '#c0392b' },
  failText: { fontSize: 10, color: '#c0392b' },
  line: { paddingVertical: 2 },
});
