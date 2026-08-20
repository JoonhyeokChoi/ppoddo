// ---------------------------------------------------------------------------
// forge-test.js — proves ppoddo-api rejects forged Supabase JWTs.
//
//   node scripts/forge-test.js <access_token>
//
// Copy a real access token from the Phase 2 test screen in the app and pass it
// here. The script forges variations of it and sends each to a real
// authenticated endpoint (GET /me), reporting the status and the body's error
// code against what we expect.
//
// WHY THIS EXISTS
//
// A JWT's payload is just base64url — anyone can open it, change `sub` to
// somebody else's user id, and re-encode it in about thirty seconds. The only
// thing standing between a stranger and another family's photos is the
// signature check. Phase 2's on-device tests were all positive-path or
// expected-by-state failures (not a member, no session); none of them proved
// that a *tampered* token is actually rejected. This does.
//
// The design invariant being tested (CLAUDE.md, Auth and authorization):
//   - the user id comes from the verified `sub` claim, never from a payload
//     taken at face value;
//   - the algorithm is pinned to what the key uses (ES256), never read from
//     the token header — so `alg: none` and `alg: HS256` confusion both fail.
//
// This script changes NO backend code and holds no secret. The "secret" used
// in the alg-confusion test is the PUBLIC key, which is the whole point of that
// attack: a server that trusts the header would use a published value to verify.
//
// A malformed token also produces a 401, which would look like a pass while
// proving nothing. So every forged token's decoded header and payload are
// printed before it is sent — confirm by eye that each is well-formed and
// actually says what it should before trusting the PASS.
// ---------------------------------------------------------------------------

import { createHmac, createPublicKey, randomUUID } from "node:crypto";

// The deployed service. Override with API_BASE=... for a local run.
const API_BASE =
  process.env.API_BASE || "https://ppoddo-api-214788185057.asia-northeast3.run.app";

// The endpoint to probe. GET /me is the cheapest authenticated route — it needs
// only a valid token, not a group membership, so a rejection here is about the
// token and nothing else.
const ENDPOINT = "/me";

// ---------------------------------------------------------------------------
// base64url — the JWT alphabet. Getting this wrong would corrupt a token and
// earn a 401 for the wrong reason, so it is handled explicitly rather than by
// hoping Buffer's "base64" mode is close enough (it is not: it uses +/ and
// requires padding).
// ---------------------------------------------------------------------------

function b64urlDecodeToBuffer(segment) {
  // Restore the standard alphabet and the padding base64 requires.
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function b64urlDecodeToString(segment) {
  return b64urlDecodeToBuffer(segment).toString("utf8");
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Re-encode an object as a JWT segment. JSON.stringify with no spacing, because
// the exact bytes are what get signed — pretty-printing would change the
// signing input.
function encodeJson(obj) {
  return b64urlEncode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

function splitToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(
      `expected a three-part JWT (header.payload.signature), got ${parts.length} part(s). ` +
        "Copy the whole access_token, not a truncated log line.",
    );
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecodeToString(headerB64));
  } catch (err) {
    throw new Error(`token header is not valid base64url JSON: ${err.message}`);
  }
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch (err) {
    throw new Error(`token payload is not valid base64url JSON: ${err.message}`);
  }
  return { headerB64, payloadB64, signatureB64, header, payload };
}

// ---------------------------------------------------------------------------
// The alg-confusion secret: the issuer's PUBLIC signing key, as PEM.
//
// The attack: a server that reads `alg` from the header and sees HS256 switches
// to symmetric verification, and the only "key" it has for this issuer is the
// public one from the JWKS. If it uses that public value as the HMAC secret,
// then anyone — who can also read the public JWKS — can forge a token it
// accepts. The defence is to never read `alg` from the header; this test proves
// ppoddo-api has that defence.
//
// The canonical form of the attack uses the SPKI PEM text of the public key as
// the HMAC secret, so that is what is reconstructed here from the JWKS JWK.
// ---------------------------------------------------------------------------

async function fetchPublicKeyPem(issuer) {
  // GoTrue stamps iss as <project url>/auth/v1, and the JWKS sits beside it.
  const jwksUrl = `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const res = await fetch(jwksUrl);
  if (!res.ok) {
    throw new Error(`could not fetch JWKS at ${jwksUrl}: HTTP ${res.status}`);
  }
  const jwks = await res.json();
  const jwk = jwks.keys?.[0];
  if (!jwk) throw new Error(`JWKS at ${jwksUrl} contained no keys`);

  // Import the JWK and export it as SPKI PEM — the exact text a vulnerable
  // server would feed to its HMAC verifier.
  const keyObject = createPublicKey({ key: jwk, format: "jwk" });
  const pem = keyObject.export({ type: "spki", format: "pem" });
  return { pem, jwk, jwksUrl };
}

// ---------------------------------------------------------------------------
// Sending and reporting
// ---------------------------------------------------------------------------

async function send(token) {
  const res = await fetch(`${API_BASE}${ENDPOINT}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let code = null;
  let bodyText = "";
  try {
    bodyText = await res.text();
    code = bodyText ? JSON.parse(bodyText).code ?? null : null;
  } catch {
    // Non-JSON body (a proxy error page, say). Keep a slice for the log.
    code = null;
  }
  return { status: res.status, code, bodyText };
}

function printDecoded(label, headerObj, payloadObj) {
  // Printed so a malformed forgery cannot masquerade as a rejected one. Read
  // these: the header must say what the test claims (alg none, alg HS256), and
  // the payload's sub must be the tampered value, not the original.
  console.log(`    decoded header : ${JSON.stringify(headerObj)}`);
  console.log(`    decoded payload: ${JSON.stringify(trimPayloadForDisplay(payloadObj))}`);
}

// Payloads carry a lot of noise (session_id, amr, app_metadata…). Show the
// claims that matter for this test and summarise the rest.
function trimPayloadForDisplay(payload) {
  const keep = ["sub", "iss", "aud", "exp", "email", "role"];
  const shown = {};
  for (const k of keep) if (k in payload) shown[k] = payload[k];
  const others = Object.keys(payload).filter((k) => !keep.includes(k));
  if (others.length) shown["…"] = `+${others.length} more: ${others.join(", ")}`;
  return shown;
}

let anyFailed = false;

function report(name, expectedStatus, result) {
  const pass = result.status === expectedStatus;
  if (!pass) anyFailed = true;
  console.log(
    `    -> status ${result.status} (expected ${expectedStatus})` +
      `  code=${result.code ?? "(none)"}  ${pass ? "PASS" : "FAIL"}`,
  );
  if (!pass && result.bodyText) {
    console.log(`    body: ${result.bodyText.slice(0, 300)}`);
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = process.argv[2];
  if (!token) {
    console.error("usage: node scripts/forge-test.js <access_token>");
    console.error("Copy a real access token from the Phase 2 test screen in the app.");
    process.exit(2);
  }

  console.log(`target: ${API_BASE}${ENDPOINT}\n`);

  const { headerB64, payloadB64, signatureB64, header, payload } = splitToken(token);

  // A different but structurally valid UUID. This is the id the forger is
  // trying to become. It must differ from the real sub or the test is vacuous.
  let fakeSub = randomUUID();
  while (fakeSub === payload.sub) fakeSub = randomUUID();

  const tamperedPayload = { ...payload, sub: fakeSub };
  const tamperedPayloadB64 = encodeJson(tamperedPayload);

  console.log("original token:");
  console.log(`    real sub  : ${payload.sub}`);
  console.log(`    forged sub: ${fakeSub}  (what the attacker wants to become)`);
  console.log(`    header    : ${JSON.stringify(header)}\n`);

  // ---- 0. CONTROL — the unmodified token. Proves the token is live and that
  // 200 is reachable at all. If this is not 200 the token has expired and every
  // forged 401 below would be a false pass, so the run stops here.
  console.log("0. CONTROL — unmodified token (expect 200)");
  const control = await send(token);
  report("CONTROL", 200, control);
  if (control.status !== 200) {
    console.log(
      "\nCONTROL did not return 200 — the token is likely expired. " +
        "A fresh token is needed; the forged tests below would 401 for the wrong " +
        "reason and prove nothing. Stopping.",
    );
    process.exit(1);
  }
  console.log("");

  // ---- 1. TAMPERED SUB — the impersonation attack. Change sub, keep the
  // original header and the original signature. The signature no longer matches
  // the payload, so it must be rejected. A pass here (i.e. a 401) is the single
  // most important result in this file.
  console.log("1. TAMPERED SUB — forged sub, original signature (expect 401)");
  const forged1 = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;
  printDecoded("tampered-sub", header, tamperedPayload);
  report("TAMPERED SUB", 401, await send(forged1));
  console.log("");

  // ---- 2. ALG NONE — the "no signature at all" attack. Rebuild the header as
  // alg:none and send an empty signature segment, keeping the tampered sub so a
  // pass would be a real compromise, not a harmless echo of the valid token.
  console.log('2. ALG NONE — header {"alg":"none"}, empty signature (expect 401)');
  const noneHeader = { alg: "none", typ: "JWT" };
  const noneHeaderB64 = encodeJson(noneHeader);
  const forged2 = `${noneHeaderB64}.${tamperedPayloadB64}.`;
  printDecoded("alg-none", noneHeader, tamperedPayload);
  report("ALG NONE", 401, await send(forged2));
  console.log("");

  // ---- 3. ALG CONFUSION — header claims HS256; sign with HMAC using the
  // issuer's PUBLIC key (as SPKI PEM) as the secret. A server that trusts the
  // header would verify this successfully with a value anyone can read. Keep
  // the kid so a header-trusting server would even locate "the key".
  console.log('3. ALG CONFUSION — header {"alg":"HS256"}, HMAC over the public key (expect 401)');
  const issuer = payload.iss;
  if (typeof issuer !== "string" || !/^https:\/\/.+/.test(issuer)) {
    console.log(`    FAIL — token has no usable iss claim (${JSON.stringify(issuer)}); cannot locate the JWKS`);
    anyFailed = true;
  } else {
    const { pem, jwk, jwksUrl } = await fetchPublicKeyPem(issuer);
    console.log(`    JWKS         : ${jwksUrl}`);
    console.log(`    key alg/kty  : ${jwk.alg ?? "?"} / ${jwk.kty} (public key used as the HMAC secret)`);

    const hsHeader = { alg: "HS256", typ: "JWT", ...(header.kid ? { kid: header.kid } : {}) };
    const hsHeaderB64 = encodeJson(hsHeader);
    const signingInput = `${hsHeaderB64}.${tamperedPayloadB64}`;
    // HMAC over the signing input with the PEM text as the shared secret — the
    // exact bytes a vulnerable verifier would recompute and match.
    const hmac = createHmac("sha256", pem).update(signingInput).digest();
    const forged3 = `${signingInput}.${b64urlEncode(hmac)}`;
    printDecoded("alg-confusion", hsHeader, tamperedPayload);
    report("ALG CONFUSION", 401, await send(forged3));
  }
  console.log("");

  // ---- Summary
  console.log("=".repeat(60));
  if (anyFailed) {
    console.log(
      "RESULT: FAIL — at least one forged or tampered token was NOT rejected as " +
        "expected. Do not deploy further until this is understood. The decoded " +
        "header/payload above confirm the forgeries were well-formed, so a FAIL " +
        "is a real gap in verification, not a malformed-token artifact.",
    );
    process.exit(1);
  }
  console.log(
    "RESULT: PASS — the control succeeded and all three forgeries were rejected. " +
      "The signature check is doing its job: sub cannot be swapped, alg:none is " +
      "refused, and the public key cannot be used as an HMAC secret.",
  );
}

main().catch((err) => {
  console.error(`\nforge-test errored (this is not a test result): ${err.message}`);
  process.exit(2);
});
