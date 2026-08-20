// ---------------------------------------------------------------------------
// The one Supabase client for the app.
//
// Created exactly once, at module scope. Two clients would keep two copies of
// the session and two refresh timers racing to rotate the same refresh token —
// and a refresh token is single-use, so the loser gets logged out at a moment
// nobody can reproduce. Import this module; never call createClient elsewhere.
//
// Supabase provides auth and the database only. Files live in GCS, reached
// through Cloud Run — see CLAUDE.md. Nothing here should ever touch storage.
// ---------------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

/**
 * The anon key is published deliberately: it ships inside the app bundle and
 * anyone can extract it. That is why every table has RLS enabled with zero
 * policies — default deny — and why Cloud Run holds the service_role key
 * instead. Do not treat this value as a secret, and do not add a policy to
 * "make the anon key useful".
 */
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Loud at import rather than as a confusing network error on the first call.
  // EXPO_PUBLIC_* variables are inlined by Metro at bundle time, so a missing
  // one is not "undefined at runtime" — it never made it into the bundle, and
  // editing .env requires restarting Metro with the cache cleared.
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are missing. ' +
      'Copy .env.example to .env, fill in the anon key, then restart Metro with ' +
      '`npx expo start --clear` — a running bundler will not pick up a new .env.',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // AsyncStorage, not SecureStore. The threat model is six known family
    // members, and SecureStore caps an item at 2048 bytes — a Supabase session
    // carrying both tokens can exceed that, which would force splitting the
    // session across keys and reassembling it on every read.
    storage: AsyncStorage,

    // Rotate the access token in the background before it expires. Without
    // this, the app works until the first expiry and then fails in a way that
    // looks like a backend outage.
    autoRefreshToken: true,

    // Write the session to storage so reopening the app does not mean logging
    // in again. Grandparents will not re-authenticate; if they are ever asked
    // to, they will stop using the app.
    persistSession: true,

    // WEB ONLY — must be false here. It tells the client to look for tokens in
    // window.location, which does not exist in React Native. Leaving it on
    // makes the flow hang rather than fail with a message.
    detectSessionInUrl: false,

    // PKCE is required on mobile: the app cannot hold a client secret, since
    // anyone can unpack the bundle. The client keeps a code verifier locally
    // and sends only its hash to start the flow, so an intercepted redirect
    // code cannot be exchanged by anyone else.
    flowType: 'pkce',
  },
});
