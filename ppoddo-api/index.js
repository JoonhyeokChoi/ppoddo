import http from "node:http";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import pg from "pg";

const port = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET || "ppoddo";
const PROJECT_ID = process.env.GCP_PROJECT_ID || "ppoddo-504520";

const storage = new Storage({ projectId: PROJECT_ID });

// ---------------------------------------------------------------------------
// Supabase JWT verification
//
// Every request carries a Supabase access token. This service verifies the
// signature against Supabase's published JWKS and takes the user id from the
// `sub` claim — never from the request body, where a UUID is a claim rather
// than evidence (CLAUDE.md, Auth and authorization).
//
// Group membership is deliberately NOT read from the token. It is queried from
// Postgres on every request, because a JWT cannot be revoked and a memberships
// row can.
// ---------------------------------------------------------------------------

// The project URL, e.g. https://sbyjkhnvithvluowrzao.supabase.co. This is not a
// secret — it is in the app bundle too — so it is a plain env var, not a
// Secret Manager entry. It is nonetheless load-bearing: it is the single value
// that pins accepted tokens to OUR Supabase project.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
if (!SUPABASE_URL) {
  // Fail at startup, not per request. A backend that boots and then 401s every
  // call looks like an auth bug; this looks like what it is, in the deploy log.
  throw new Error(
    "SUPABASE_URL is not set. Deploy with " +
      "--set-env-vars SUPABASE_URL=https://<project-ref>.supabase.co",
  );
}

// GoTrue stamps `iss` as <project url>/auth/v1.
//
// Checking it is what rejects a token that is perfectly well-formed, unexpired
// and correctly signed — by somebody else's Supabase project. Anyone can create
// a project in a minute, so without this check the signature check alone proves
// only "some Supabase issued this", not "ours did".
const JWT_ISSUER = `${SUPABASE_URL}/auth/v1`;

// Supabase sets aud=authenticated for a signed-in end user. Anonymous sign-ins
// and other token types carry different values and have no business here.
const JWT_AUDIENCE = "authenticated";

// RS256 ONLY — pinned here, never read from the token header.
//
// The `alg` field in a JWT header is chosen by whoever sends the token, which
// is to say by the attacker. Two classic attacks follow from believing it:
//
//   alg: none   the library concludes there is nothing to verify and accepts
//               any payload at all
//   alg: HS256  the library switches to symmetric verification and uses the
//               RSA PUBLIC key as the HMAC secret — and that key is published
//               at the JWKS URL below, so anyone can mint valid tokens
//
// Passing `algorithms` makes jose reject the header before it selects a key,
// so neither substitution ever reaches the verification step.
//
// ES256, verified 2026-08-19 against this project's actual key set:
//
//   {"alg":"ES256","crv":"P-256","kty":"EC","use":"sig","kid":"be3d8743-..."}
//
// This is an elliptic-curve key, not RSA — Supabase's newer projects default to
// EC. The list started as ["RS256"] on the assumption that asymmetric meant RSA,
// and every single request 401'd as invalid_token with a valid, freshly issued
// token. The symptom is total and instant, which is the good case; the same
// mistake in reverse (accepting more algorithms than the key uses) would have
// been silent.
//
// If the key is ever rotated to a different type, this line is the fix. Check:
//   curl -s $SUPABASE_URL/auth/v1/.well-known/jwks.json | grep -o '"alg":"[^"]*"'
// Name the new algorithm; never widen this to "whatever the token says".
const JWT_ALGORITHMS = ["ES256"];

// Fetched once and cached in memory. Fetching per request would add a network
// round trip to every call and make Supabase's availability a hard dependency
// of ours.
//
// createRemoteJWKSet also handles rotation on its own, which is the reason not
// to hand-roll this: a token whose `kid` is not in the cached set triggers ONE
// refetch before being rejected. That case is exactly the one that matters,
// because a freshly rotated signing key is otherwise indistinguishable from a
// forged token. cooldownDuration bounds how often that refetch can fire, so a
// flood of tokens carrying junk `kid`s cannot be turned into a flood of
// requests against Supabase.
const JWKS_URL = new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
const JWKS = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000, // at most one unknown-kid refetch per 30s
  cacheMaxAge: 10 * 60_000, // refresh a healthy key set every 10 minutes
  timeoutDuration: 5_000,
});

// Signed URL lifetime. Computed as now + 15 minutes at mint time, never rounded
// to a clock boundary.
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

// IAM / auth errors carry useful nested detail that the top-level message hides.
function describeError(err) {
  const parts = [err.message];
  const nested = err.response?.data ?? err.errors ?? err.cause;
  if (nested) parts.push(`detail: ${JSON.stringify(nested)}`);
  if (err.code !== undefined) parts.push(`code: ${err.code}`);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Supabase Postgres
//
// DATABASE_URL is injected by Cloud Run from Secret Manager (--set-secrets).
// It is never committed and never passed on a deploy command line.
//
// Connect through the Supavisor pooler host, not db.<ref>.supabase.co: the
// direct host resolves to IPv6 only, and Cloud Run has no outbound IPv6 without
// direct VPC egress. A direct-host URL fails here as ENETUNREACH / ENOTFOUND.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

// Parsed for logging only — nothing secret is ever logged, just host/port/user.
function describeDatabaseUrl(url) {
  if (!url) return { present: false };
  try {
    const u = new URL(url);
    // Supavisor hosts look like aws-0-ap-northeast-2.pooler.supabase.com, so the
    // cloud region is readable straight off the hostname.
    const region = /^[a-z]+-\d+-([a-z]+-[a-z]+-\d+)\.pooler\./.exec(u.hostname)?.[1] ?? null;
    const port = u.port || "5432";
    return {
      present: true,
      host: u.hostname,
      port,
      user: decodeURIComponent(u.username),
      database: u.pathname.replace(/^\//, "") || "postgres",
      // Supavisor: 6543 is transaction mode, 5432 session mode.
      poolerMode: port === "6543" ? "transaction" : port === "5432" ? "session" : "unknown",
      region,
      direct: u.hostname.endsWith(".supabase.co"),
    };
  } catch (err) {
    return { present: true, parseError: err.message };
  }
}

const dbInfo = describeDatabaseUrl(DATABASE_URL);

// ---------------------------------------------------------------------------
// TLS trust: certs/prod-ca-2021.crt
//
// *** THIS FILE IS PUBLIC. IT IS NOT A SECRET AND NEVER WAS. ***
//
// A CA certificate contains a public key and nothing else — no private key, no
// password, no token. Certificate authorities are *designed* to be distributed
// as widely as possible; every browser on earth ships thousands of these. This
// one is simply Supabase's own root, downloaded from their dashboard, which is
// not in Mozilla's public root store and so is not in Node's bundled CA list.
//
// It therefore belongs in the repository, committed in plain sight, NOT in
// Secret Manager. Putting it in Secret Manager would add a secret to manage, a
// deploy-time dependency, and an IAM binding — all to protect a value that
// Supabase publishes on a public download page.
//
// This note exists because a .crt file sitting next to database config *looks*
// like a leaked credential at a glance. It is not. Do not "fix" it by moving
// it, encrypting it, or adding it to .gitignore.
//
// The direction here is easy to get backwards: Supabase is the server and
// presents this certificate; Cloud Run is the client and verifies it. The
// password proves who *we* are; the certificate proves who *they* are.
// ---------------------------------------------------------------------------

// package.json sets "type": "module", so there is no __dirname. Resolving from
// import.meta.url makes the path independent of the process working directory —
// a relative "./certs/..." would break the moment anything starts the server
// from another folder.
const HERE = dirname(fileURLToPath(import.meta.url));
const CA_PATH = join(HERE, "certs", "prod-ca-2021.crt");

let SUPABASE_CA;
try {
  SUPABASE_CA = readFileSync(CA_PATH, "utf8");
} catch (err) {
  // Fail loudly at startup rather than letting every query fail later with a
  // TLS error that reads like a network outage. The usual cause is the file
  // being missing from the deployed source: check that .gcloudignore (and any
  // .dockerignore) does not exclude certs/ or *.crt.
  throw new Error(
    `Supabase CA certificate not readable at ${CA_PATH}: ${err.message}. ` +
      "It must be committed to the repo and included in the deployed source.",
  );
}

// Every path that opens a Postgres connection must use this. When /debug/db
// existed it held a second, separate client, and for a while that one still had
// rejectUnauthorized: false — so the endpoint measuring the connection was not
// measuring the connection the endpoints actually used. Keep it a single
// constant if a second connection is ever introduced again.
const DB_SSL = { ca: SUPABASE_CA, rejectUnauthorized: true };

// Read once at startup: a silently expired CA would take the backend down with
// a TLS error, and nothing else in the system would announce the date.
function describeCa(pem) {
  try {
    const cert = new X509Certificate(pem);
    const validTo = new Date(cert.validTo);
    return {
      subject: cert.subject.split("\n").find((l) => l.startsWith("CN=")) ?? cert.subject,
      validFrom: new Date(cert.validFrom),
      validTo,
      daysLeft: Math.floor((validTo - Date.now()) / 86_400_000),
      fingerprint: cert.fingerprint256,
    };
  } catch (err) {
    return { parseError: err.message };
  }
}

const caInfo = describeCa(SUPABASE_CA);

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

// Without this an idle client dropped by the pooler takes the process down.
pool?.on("error", (err) => {
  console.error("pg pool idle client error:", describeError(err));
});

// Logged once at startup so a connection failure is diagnosable from the Cloud
// Run logs alone, without hitting the route.
async function logDatabaseStartup() {
  console.log("--- database pool ---");

  // Logged before the pool check so the CA is reported even without a DATABASE_URL.
  console.log(`TLS verification  : ON (rejectUnauthorized: true)`);
  if (caInfo.parseError) {
    console.error(`CA certificate    : UNPARSEABLE — ${caInfo.parseError} (${CA_PATH})`);
  } else {
    console.log(`CA certificate    : ${caInfo.subject} (public, committed to the repo)`);
    console.log(
      `CA expires        : ${caInfo.validTo.toISOString().slice(0, 10)} (${caInfo.daysLeft} days from now)`,
    );
    console.log(`CA sha256         : ${caInfo.fingerprint}`);
    // 90 days is enough warning to download the replacement and redeploy calmly.
    if (caInfo.daysLeft < 0) {
      console.error("ERROR: the Supabase CA certificate has EXPIRED — TLS verification will fail.");
    } else if (caInfo.daysLeft < 90) {
      console.warn(
        `WARNING: the Supabase CA certificate expires in ${caInfo.daysLeft} days. ` +
          "Download the current one from the Supabase dashboard and replace certs/prod-ca-2021.crt.",
      );
    }
  }

  if (!pool) {
    console.log("pool initialised  : NO — DATABASE_URL is not set");
    console.log("---------------------");
    return;
  }
  console.log(`pool initialised  : yes (max ${pool.options.max})`);
  console.log(`host              : ${dbInfo.host}:${dbInfo.port}`);
  console.log(`user / database   : ${dbInfo.user} / ${dbInfo.database}`);
  console.log(`pooler mode       : ${dbInfo.poolerMode}`);
  console.log(`region (from host): ${dbInfo.region ?? "(not discoverable from hostname)"}`);
  if (dbInfo.direct) {
    console.log("WARNING: direct Supabase host is IPv6-only; Cloud Run cannot reach it.");
  }

  // A pool is lazy — it proves nothing until a connection is actually opened.
  try {
    const started = Date.now();
    const { rows } = await pool.query(
      "select version() as version, current_user as who, current_setting('TimeZone') as tz",
    );
    console.log(`first connection  : ok in ${Date.now() - started}ms`);
    console.log(`server            : ${rows[0].version.split(",")[0]}`);
    console.log(`connected as      : ${rows[0].who} (TimeZone ${rows[0].tz})`);
  } catch (err) {
    console.error(`first connection  : FAILED — ${describeError(err)}`);
  }
  console.log("---------------------");
}

// Logged once at startup so a signing failure can be diagnosed from the Cloud
// Run logs alone. On Cloud Run this should report a Compute client with no
// private key — signing then goes through iamcredentials.googleapis.com.
async function logResolvedCredentials() {
  console.log("--- resolved credentials ---");
  try {
    const auth = storage.authClient;
    const client = await auth.getClient();
    const type = client.constructor.name;
    console.log(`auth client class : ${type}`);

    const hasPrivateKey = Boolean(
      client.key || client.credentials?.private_key || client.jsonContent?.private_key,
    );
    if (type === "Impersonated") {
      console.log(`impersonating     : ${client.targetPrincipal}`);
      console.log(`signing path      : IAM signBlob (iamcredentials.googleapis.com)`);
    } else if (type === "Compute") {
      console.log(`source            : GCE/Cloud Run metadata server`);
      console.log(`signing path      : IAM signBlob (iamcredentials.googleapis.com)`);
    } else if (hasPrivateKey) {
      console.log(`signing path      : LOCAL PRIVATE KEY  <-- this is a key file!`);
    } else {
      console.log(`signing path      : ${type} (no local private key detected)`);
    }

    try {
      const creds = await auth.getCredentials();
      console.log(`client_email      : ${creds.client_email ?? "(none)"}`);
      console.log(`has private_key   : ${creds.private_key ? "YES" : "no"}`);
    } catch (err) {
      console.log(`client_email      : (unavailable) ${err.message}`);
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log(
        `NOTE: GOOGLE_APPLICATION_CREDENTIALS is set to ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`,
      );
    }
  } catch (err) {
    console.log(`credential resolution failed: ${describeError(err)}`);
  }
  console.log("----------------------------");
}

// ===========================================================================
// Endpoints
// ===========================================================================

// A thrown HttpError becomes a JSON response with that status. Anything else
// thrown becomes a 500 with a generic body — internal detail goes to the log,
// not to the client.
//
// `code` is a stable machine-readable tag, and it carries weight the status
// alone cannot: three of these are 4xx responses that the app must react to in
// three completely different ways (refresh the token, show onboarding, show a
// no-access message). The client must branch on `code`, never on the prose in
// `error`, which exists for whoever is reading a log.
class HttpError extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Authentication — runs before every protected handler.
//
// Returns { userId }. The id is the `sub` claim, which IS the application's
// user id: public.users.id is the same UUID as auth.users.id, so there is no
// mapping lookup in the hot path (CLAUDE.md, Database schema).
//
// Everything here answers ONE question — "who is asking" — and nothing about
// what they may do. Authorization is a separate, per-request database check,
// and it happens inside each handler.
// ---------------------------------------------------------------------------
async function authenticate(req) {
  const header = req.headers.authorization;
  if (!header) {
    throw new HttpError(401, "missing Authorization header", "missing_token");
  }
  // The scheme is case-insensitive per RFC 7235; a client sending "bearer" is
  // not making a mistake, and rejecting it would be an hour lost to a typo.
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    throw new HttpError(401, "Authorization must be: Bearer <token>", "invalid_token");
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], JWKS, {
      algorithms: JWT_ALGORITHMS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      // jose checks exp (and nbf) by default. The five seconds of tolerance are
      // for clock skew between Supabase and this container, not generosity: at
      // zero, a token can be rejected microseconds before the client's own
      // refresh timer would have fired, producing a 401 that nothing can
      // reproduce. Five seconds of extra life on a one-hour token is noise.
      clockTolerance: 5,
    }));
  } catch (err) {
    // A JWKS that cannot be fetched is OUR outage, not a bad token. Returning
    // 401 for it would tell every family member to log in again, which would
    // not help and cannot work while Supabase is unreachable.
    if (err instanceof joseErrors.JWKSTimeout || err?.code === "ERR_JWKS_TIMEOUT") {
      console.error("JWKS fetch failed:", describeError(err));
      throw new HttpError(503, "cannot reach the identity provider", "jwks_unavailable");
    }
    if (err instanceof joseErrors.JWTExpired) {
      // Split out from the other failures because it is the ONE case the client
      // can fix by itself, by refreshing and retrying. Everything else below
      // means log in again.
      throw new HttpError(401, "token expired", "expired_token");
    }
    // Signature failures, wrong issuer, wrong audience, a forbidden `alg`, an
    // unknown `kid` after the refetch — all deliberately collapsed into one
    // response. Telling a caller which check failed helps nobody debugging a
    // real client and helps somebody probing the endpoint quite a lot. The
    // distinction is kept in the log instead.
    console.warn(`JWT rejected: ${err?.code ?? err?.name} ${err?.message}`);
    throw new HttpError(401, "invalid token", "invalid_token");
  }

  // A `sub` that is not a UUID cannot be a Supabase user id, and it is about to
  // be used as one against a uuid column. Postgres would reject it as a type
  // error, which surfaces as a 500 — a validation failure wearing a crash's
  // clothing.
  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
    console.warn(`JWT has an unusable sub claim: ${JSON.stringify(payload.sub)}`);
    throw new HttpError(401, "invalid token", "invalid_token");
  }

  return { userId: payload.sub.toLowerCase(), email: payload.email ?? null };
}

// ---------------------------------------------------------------------------
// A valid token from a user who has not finished onboarding.
//
// There is no "onboarded" flag anywhere. The EXISTENCE of the public.users row
// is the signal (CLAUDE.md, Database schema), so every protected endpoint has
// to handle "the token is fine, but there is no profile" as its own outcome.
//
// It is a third state, not a variation of the other two, and the app has to
// tell all three apart to know what to show:
//
//   401 invalid_token / expired_token -> refresh, or send them to log in again
//   403 profile_required              -> send them to onboarding
//   403 not_a_member                  -> they are signed up, just not invited
//
// Sharing the 403 status with not_a_member is why `code` exists on every error
// body: the two mean opposite things and must never be handled by status alone.
// ---------------------------------------------------------------------------
function requireProfile(hasProfile) {
  if (!hasProfile) {
    throw new HttpError(403, "no profile yet — finish onboarding", "profile_required");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// 64KB is far more than any Phase 1 request needs; the cap exists so a bad or
// hostile client cannot make the process buffer without limit.
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "a JSON body is required");
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (err) {
    throw new HttpError(400, `invalid JSON body: ${err.message}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, what) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, `${what} must be a UUID, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

// Validates the calendar date itself, not just the shape: 2026-02-31 matches the
// regex but is not a day, and Postgres would reject it with a less useful error.
function requireDate(value, what) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    throw new HttpError(400, `${what} is not a real date: ${value}`);
  }
  return value;
}

// Phase 1 is photo-only and writes the fixed `original.jpg` slot, so the content
// type is pinned to JPEG rather than merely being "some image": a .jpg object
// holding a PNG is a small lie that costs someone an hour later. Device-side
// compression produces JPEG, so nothing legitimate is being turned away. Widen
// this deliberately (and rename the object) if that ever changes.
const ALLOWED_PHOTO_CONTENT_TYPES = ["image/jpeg"];

// The object path carries only immutable facts — kind and id. Group, date and
// deletion state are mutable and live in Postgres (CLAUDE.md, Storage paths).
function objectPathFor(kind, mediaId) {
  if (kind === "photo") return `photos/${mediaId}/original.jpg`;
  if (kind === "video") return `videos/${mediaId}/compressed.mp4`;
  throw new Error(`no object path defined for kind ${kind}`);
}

function requirePool() {
  if (!pool) throw new HttpError(503, "DATABASE_URL is not configured", "database_unavailable");
  return pool;
}

// ---------------------------------------------------------------------------
// Signed URL expiry. Fixed at 15 minutes, computed as now + 15min, never
// rounded to a clock boundary.
//
// The Phase 1 `?expiresInSeconds` test affordance has been DELETED, on purpose
// and permanently. It existed only because exercising the expiry retry path at
// the real fifteen minutes costs fifteen minutes per attempt. That reason is
// spent — the retry path and its bound were both verified on device — and now
// that auth exists it would be a hole rather than a convenience: a caller who
// chooses the lifetime chooses how long a leaked bearer credential stays live.
//
// Do not reintroduce it, and do not promote it to an environment variable.
// ---------------------------------------------------------------------------
function signedUrlExpiryMs() {
  return Date.now() + SIGNED_URL_TTL_MS;
}

// ---------------------------------------------------------------------------
// GET /me
//
// The app calls this right after login to decide between the feed and the
// onboarding screen. 404 is not an error condition here — it is the answer
// "signed in, not yet onboarded", and it is derived from the row's absence
// because the row's existence IS the onboarding flag (CLAUDE.md).
// ---------------------------------------------------------------------------
async function getMe(res, auth) {
  // Deliberately only the two columns this endpoint has a use for. Selecting *
  // would couple the response shape to the table, so a future column would leak
  // into the API without anyone deciding it should.
  const { rows } = await requirePool().query(
    "select id, display_name from public.users where id = $1",
    [auth.userId],
  );

  if (rows.length === 0) {
    console.log(`GET /me 404 user=${auth.userId.slice(0, 8)} (no profile yet)`);
    throw new HttpError(404, "no profile yet", "profile_required");
  }

  console.log(`GET /me 200 user=${auth.userId.slice(0, 8)}`);
  sendJson(res, 200, { id: rows[0].id, displayName: rows[0].display_name });
}

// ---------------------------------------------------------------------------
// POST /me — create the profile row. Onboarding.
//
// The id comes from the verified `sub` claim and from nowhere else. Accepting
// an id in the body would let any signed-in caller create or claim somebody
// else's profile row, which is the exact mistake the "a UUID in a payload is a
// claim, not evidence" rule exists to prevent.
// ---------------------------------------------------------------------------
async function postMe(req, res, auth) {
  const body = await readJsonBody(req);

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 40) {
    throw new HttpError(400, "displayName must be 1-40 characters", "invalid_display_name");
  }

  // `on conflict (id) do nothing` makes this idempotent, which matters more
  // than it looks: onboarding is one button on a phone with a slow connection,
  // so a double tap and a retry after a timeout are both certain to happen. A
  // second call must be a no-op, not a 409 the app has to special-case.
  const db = requirePool();
  const { rows } = await db.query(
    `with created as (
       insert into public.users (id, display_name)
       values ($1, $2)
       on conflict (id) do nothing
       returning id, display_name
     )
     select id, display_name, true as fresh from created
     union all
     select id, display_name, false as fresh from public.users
      where id = $1 and not exists (select 1 from created)`,
    [auth.userId, displayName],
  );

  let row = rows[0];

  // Normally unreachable: one branch of the union or the other produces a row.
  // The exception is a genuine race — a concurrent transaction inserts the same
  // id after this statement's snapshot is taken, so `on conflict do nothing`
  // returns nothing AND the second branch cannot see the new row either. A
  // double-tapped onboarding button is exactly how that happens. One extra read
  // settles it, rather than answering 500 to a request that in fact succeeded.
  if (!row) {
    const retry = await db.query(
      "select id, display_name from public.users where id = $1",
      [auth.userId],
    );
    if (retry.rows.length === 0) throw new Error("POST /me inserted and found nothing");
    row = { ...retry.rows[0], fresh: false };
  }

  console.log(
    `POST /me user=${auth.userId.slice(0, 8)} created=${row.fresh} email=${auth.email ?? "-"}`,
  );
  sendJson(res, row.fresh ? 201 : 200, {
    id: row.id,
    displayName: row.display_name,
    created: row.fresh,
  });
}

// ---------------------------------------------------------------------------
// POST /uploads
// ---------------------------------------------------------------------------
async function postUploads(req, res, auth) {
  const expires = signedUrlExpiryMs();
  const body = await readJsonBody(req);

  if (body.kind !== "photo") {
    throw new HttpError(400, `kind must be "photo" in Phase 1, got ${JSON.stringify(body.kind)}`);
  }
  if (!ALLOWED_PHOTO_CONTENT_TYPES.includes(body.contentType)) {
    throw new HttpError(
      400,
      `contentType must be one of ${ALLOWED_PHOTO_CONTENT_TYPES.join(", ")}, got ${JSON.stringify(body.contentType)}`,
    );
  }
  if (!Array.isArray(body.groupIds) || body.groupIds.length === 0) {
    throw new HttpError(400, "groupIds must be a non-empty array of group UUIDs");
  }
  const groupIds = [...new Set(body.groupIds.map((g, i) => requireUuid(g, `groupIds[${i}]`)))];

  const client = await requirePool().connect();
  let mediaId;
  let postedOn;
  try {
    await client.query("BEGIN");

    // Authorization before writing, inside the transaction, against the same
    // snapshot the inserts use. Without this, a caller could file media into a
    // group they do not belong to — the write-side twin of the read-side check
    // on the list endpoint.
    //
    // The profile check rides along in the same statement rather than costing a
    // second round trip. Both facts are about the same user at the same instant,
    // and the measured cost of this query is almost entirely the round trip
    // (6.4ms pooled, Seoul to Seoul) rather than the work.
    //
    // The membership count is exact rather than a subset test because groupIds
    // is deduplicated above and (user_id, group_id) is the composite primary
    // key — so one row per requested group is the only possible match.
    const { rows: check } = await client.query(
      `select
         exists (select 1 from public.users where id = $1) as has_profile,
         (select count(*) from public.memberships
           where user_id = $1 and group_id = any($2::uuid[]))::int as member_count`,
      [auth.userId, groupIds],
    );

    requireProfile(check[0].has_profile);

    if (check[0].member_count !== groupIds.length) {
      // Deliberately says nothing about which ids exist or which membership is
      // missing — same reasoning as the 403 on the list endpoint.
      throw new HttpError(403, "not a member of every requested group", "not_a_member");
    }

    // posted_on is computed in Postgres as the current KST calendar day. Doing it
    // here rather than from created_at (UTC) is the whole point: a 08:30 KST
    // upload is 23:30 UTC the previous day, and date(created_at) would file it
    // under yesterday. Not accepted from the client in Phase 1.
    const { rows } = await client.query(
      `insert into public.media (kind, status, posted_on, uploaded_by)
       values ($1, 'pending', (now() at time zone 'Asia/Seoul')::date, $2)
       returning id, posted_on`,
      [body.kind, auth.userId],
    );
    mediaId = rows[0].id;
    postedOn = rows[0].posted_on;

    // One statement, one row per group — unnest keeps it a single round trip.
    const inserted = await client.query(
      `insert into public.media_groups (media_id, group_id)
       select $1, g from unnest($2::uuid[]) as g`,
      [mediaId, groupIds],
    );
    if (inserted.rowCount !== groupIds.length) {
      throw new Error(`expected ${groupIds.length} media_groups rows, inserted ${inserted.rowCount}`);
    }

    await client.query("COMMIT");
  } catch (err) {
    // Rolling back is what guarantees the invariant: a media row must never
    // exist without its media_groups rows, which would be a photo belonging to
    // no group — invisible to every feed query and reachable by nothing.
    await client.query("ROLLBACK").catch((rollbackErr) => {
      console.error("ROLLBACK failed:", describeError(rollbackErr));
    });
    throw err;
  } finally {
    // Must run on every path, including the throw above. A leaked client
    // permanently removes one connection from a pool of five.
    client.release();
  }

  // Signed after COMMIT, so a slow IAM signBlob call never holds a database
  // transaction open. If signing fails here the row survives as `pending` with
  // no object behind it — harmless, since nothing lists pending media, and the
  // client simply retries. The reverse order would risk the opposite: an object
  // with no row, which nothing can find or clean up.
  const objectPath = objectPathFor(body.kind, mediaId);
  const [uploadUrl] = await storage
    .bucket(BUCKET)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires,
      // The client's PUT must send exactly this Content-Type. It is part of the
      // signed string (X-Goog-SignedHeaders=content-type;host), so any
      // difference fails as a generic 403 that reads like a permissions problem.
      contentType: body.contentType,
    });

  console.log(
    `POST /uploads media=${mediaId} groups=${groupIds.length} posted_on=${postedOn} path=${objectPath}`,
  );
  sendJson(res, 201, { mediaId, uploadUrl, objectPath });
}

// ---------------------------------------------------------------------------
// POST /uploads/:mediaId/complete
// ---------------------------------------------------------------------------
async function postUploadComplete(req, res, mediaIdParam, auth) {
  const mediaId = requireUuid(mediaIdParam, "mediaId");

  // One statement so "does the row exist" and "flip it" see the same snapshot;
  // two queries could disagree with a concurrent retry between them. The `target`
  // CTE reads the pre-update snapshot, so prior_status is the status as found.
  //
  // Scoped to uploaded_by, which is now the JWT subject: a non-match returns the
  // same 404 as a missing row rather than confirming that someone else's media
  // exists. Someone else's media id is therefore indistinguishable from a typo.
  const { rows } = await requirePool().query(
    `with target as (
       select id, status from public.media where id = $1 and uploaded_by = $2
     ), updated as (
       update public.media set status = 'ready'
       where id = $1 and uploaded_by = $2 and status = 'pending'
       returning id
     )
     select
       exists (select 1 from public.users where id = $2) as has_profile,
       (select count(*) from target)::int  as found,
       (select count(*) from updated)::int as changed,
       (select status from target)         as prior_status`,
    [mediaId, auth.userId],
  );

  const { has_profile: hasProfile, found, changed, prior_status: priorStatus } = rows[0];
  // Checked after the statement rather than before it, to keep this a single
  // round trip. The UPDATE is harmless in the no-profile case: uploaded_by is a
  // foreign key to public.users, so a user with no profile row owns no media and
  // `target` is necessarily empty.
  requireProfile(hasProfile);

  if (!found) throw new HttpError(404, "media not found", "not_found");

  // Idempotent by design: the second call finds the row already `ready` and
  // reports success. The upload queue retries, and a retry that 409s would be
  // indistinguishable from a real failure at the client.
  console.log(
    `POST /uploads/${mediaId}/complete prior=${priorStatus} changed=${changed === 1}`,
  );
  sendJson(res, 200, { mediaId, status: "ready", changed: changed === 1 });
}

// ---------------------------------------------------------------------------
// GET /groups/:groupId/dates/:date/media
// ---------------------------------------------------------------------------
async function getGroupDateMedia(res, groupIdParam, dateParam, auth) {
  const groupId = requireUuid(groupIdParam, "groupId");
  const date = requireDate(dateParam, "date");
  const expires = signedUrlExpiryMs();
  const db = requirePool();

  // One membership check per request — not per item. Timed against the 6.4ms
  // pooled baseline measured before the debug endpoints were removed, which is
  // the number that closed the question of moving the database to Cloud SQL.
  //
  // The profile lookup shares the statement so the request still pays exactly
  // one round trip. This is the hot path: the retry logic re-lists on a failed
  // image, so it runs more often than the number of screens suggests.
  const started = process.hrtime.bigint();
  const { rows: check } = await db.query(
    `select
       exists (select 1 from public.users where id = $1) as has_profile,
       exists (select 1 from public.memberships
                where user_id = $1 and group_id = $2) as is_member`,
    [auth.userId, groupId],
  );
  const membershipMs = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;

  requireProfile(check[0].has_profile);

  if (!check[0].is_member) {
    // Identical response whether the group does not exist or the user is simply
    // not in it. Distinguishing them would turn this endpoint into an oracle for
    // enumerating group ids.
    console.log(
      `GET /groups/${groupId}/dates/${date}/media 403 not_a_member ` +
        `user=${auth.userId.slice(0, 8)} check=${membershipMs}ms`,
    );
    throw new HttpError(403, "not a member of this group", "not_a_member");
  }

  // Scoped to the one group by the join, so another group's media cannot appear
  // even if a row is shared across groups — cross-group leakage is structurally
  // impossible here rather than filtered out afterwards.
  const { rows } = await db.query(
    `select m.id, m.kind
       from public.media m
       join public.media_groups mg on mg.media_id = m.id
      where mg.group_id = $1
        and m.posted_on = $2
        and m.status = 'ready'
        and m.deleted_at is null
      order by m.created_at`,
    [groupId, date],
  );

  // Every URL in one response shares an expiry; minted in parallel because each
  // is a separate signBlob round trip.
  const items = await Promise.all(
    rows.map(async (row) => {
      const [url] = await storage
        .bucket(BUCKET)
        .file(objectPathFor(row.kind, row.id))
        .getSignedUrl({ version: "v4", action: "read", expires });
      return { mediaId: row.id, kind: row.kind, url };
    }),
  );

  console.log(
    `GET /groups/${groupId}/dates/${date}/media 200 items=${items.length} ` +
      `user=${auth.userId.slice(0, 8)} check=${membershipMs}ms`,
  );
  sendJson(res, 200, { items });
}

// ---------------------------------------------------------------------------
// Route table. Matched in order; the first pattern that matches wins.
//
// Every route here is authenticated, and there is deliberately no `public: true`
// flag to forget to set. Authentication happens in the loop below, before any
// handler runs, so a new route cannot be added unprotected by omission — the
// only way to expose one is to write the exemption explicitly, which is a thing
// a reviewer can see.
//
// This is why /debug/sign and /debug/db are gone rather than merely unlinked.
// They sat outside this table, and /debug/sign minted signed URLs for anyone who
// knew the path. On a service deployed --allow-unauthenticated (which it must
// be — the app calls it directly and the auth is ours, not IAM's) that was a way
// to obtain write access to the bucket without any token at all.
// ---------------------------------------------------------------------------
const ROUTES = [
  {
    method: "GET",
    pattern: /^\/me$/,
    handler: (req, res, _params, auth) => getMe(res, auth),
  },
  {
    method: "POST",
    pattern: /^\/me$/,
    handler: (req, res, _params, auth) => postMe(req, res, auth),
  },
  {
    method: "POST",
    pattern: /^\/uploads$/,
    handler: (req, res, _params, auth) => postUploads(req, res, auth),
  },
  {
    method: "POST",
    pattern: /^\/uploads\/([^/]+)\/complete$/,
    handler: (req, res, [mediaId], auth) => postUploadComplete(req, res, mediaId, auth),
  },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)\/dates\/([^/]+)\/media$/,
    handler: (req, res, [groupId, date], auth) => getGroupDateMedia(res, groupId, date, auth),
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    if (req.method !== route.method) {
      // Two routes share /me, so a method mismatch is only a 405 when no other
      // entry in the table would have taken this request.
      if (ROUTES.some((r) => r !== route && r.method === req.method && r.pattern.test(path))) {
        continue;
      }
      sendJson(res, 405, {
        error: `${path} accepts ${ROUTES.filter((r) => r.pattern.test(path))
          .map((r) => r.method)
          .join(", ")}`,
        code: "method_not_allowed",
      });
      return;
    }
    try {
      // Before the handler, always. The handler never sees an unverified caller,
      // and never has the option of reading an id from the request.
      const auth = await authenticate(req);
      await route.handler(req, res, match.slice(1), auth);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
      } else {
        // The client gets nothing beyond "it failed"; the detail goes to the log
        // where it is diagnosable without being exposed.
        console.error(`${req.method} ${path} failed:`, describeError(err));
        sendJson(res, 500, { error: "internal error", code: "internal_error" });
      }
    }
    return;
  }

  // Unauthenticated on purpose, and it must stay this way: Cloud Run's own
  // health checking has no token to present. It reveals nothing beyond the fact
  // that the service is up.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ppoddo-api ok\n");
});

// The issuer is the one value that decides whose users can reach this service,
// and pointing it at the wrong project fails in a way that looks like every
// login being broken. Printing it means the answer is in the deploy log rather
// than in an hour of debugging the app.
function logAuthStartup() {
  console.log("--- auth ---");
  console.log(`issuer            : ${JWT_ISSUER}`);
  console.log(`audience          : ${JWT_AUDIENCE}`);
  console.log(`algorithms        : ${JWT_ALGORITHMS.join(", ")} (pinned; token header not trusted)`);
  console.log(`JWKS              : ${JWKS_URL.href} (fetched lazily, then cached)`);
  console.log("------------");
}

server.listen(port, () => {
  console.log(`listening on ${port}`);
  // After listen, so a slow metadata server or DB handshake can never delay the
  // port opening — Cloud Run kills a container that is slow to bind.
  logAuthStartup();
  logResolvedCredentials();
  logDatabaseStartup();
});
