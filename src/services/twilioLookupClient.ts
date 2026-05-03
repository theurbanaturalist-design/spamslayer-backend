// ─────────────────────────────────────────────────────────────────────────────
//  twilioLookupClient.ts
//
//  On-demand Twilio Lookup v2 wrapper. Returns line-type intelligence for
//  the offender's phone number — landline / mobile / VoIP / etc.
//
//  WHY THIS MATTERS
//    For a TCPA small-claims case, line type is one of the strongest single
//    predictors of collectability:
//      • A LANDLINE belongs to a real business with a fixed address. The
//        carrier's CDR is reliable evidence; the number is hard to spoof
//        at the carrier level.
//      • A MOBILE could be a legitimate business cell or a prepaid burner.
//        Neutral signal.
//      • A VOIP (especially nonFixedVoip) is rented by the call from a
//        reseller. Often disposable. The "owner" is the reseller, not the
//        spammer. Service of process is hard.
//
//  ARCHITECTURE
//    • Pure async function. Never throws.
//    • 90-day disk cache at backend/cache/twilio_lookup/<sha256(e164)>.json.
//      Twilio billing is per-lookup ($0.008 at the time of writing) so
//      caching is also a cost-control measure.
//    • Twilio credentials reused from process.env.TWILIO_ACCOUNT_SID /
//      TWILIO_AUTH_TOKEN. If missing, returns "skipped" with a clear
//      reason — never a silent failure.
//
//  PRIVACY
//    The phone number leaves the box. That number is one the spammer
//    themselves dialed FROM, so we have a strong argument it's not
//    third-party PII (it identifies the caller, not the user). Still,
//    we cache by hash and don't log the number.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";
import twilio from "twilio";

// ──────────────────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────────────────

export type NormalizedLineType = "landline" | "mobile" | "voip" | "unknown";

/**
 * Discriminated-union result. Same status vocabulary as
 * openCorporatesClient so the orchestrator can treat them uniformly.
 *
 *   "match"   — Twilio returned a usable line_type_intelligence record
 *   "skipped" — credentials missing or feature not enabled (NO scoring impact)
 *   "error"   — network / API failure (NO scoring impact)
 *
 * There's no "no_match" here because Twilio Lookup always returns SOMETHING
 * for a valid E.164 number — even an unassigned number returns a record,
 * just one we'd map to "unknown".
 */
export type LineLookupResult =
  | LineLookupMatch
  | LineLookupSkipped
  | LineLookupError;

export interface LineLookupMatch {
  status: "match";
  /** Normalized 4-bucket type — what evaluateEnrichment expects. */
  normalizedType: NormalizedLineType;
  /** Verbatim raw type Twilio returned (for display): landline | mobile | fixedVoip | nonFixedVoip | personal | tollFree | premium | sharedCost | uan | voicemail | unknown. */
  rawType: string | null;
  /** Carrier name if Twilio returned one. */
  carrierName: string | null;
  /** Mobile country code (ITU MCC) if Twilio returned one. */
  mobileCountryCode: string | null;
  /** Mobile network code (ITU MNC) if Twilio returned one. */
  mobileNetworkCode: string | null;
  /** ISO country code from Twilio. */
  countryCode: string | null;
  lookedUpAt: string;
  fromCache: boolean;
}

export interface LineLookupSkipped {
  status: "skipped";
  reason: string;
}

export interface LineLookupError {
  status: "error";
  errorMessage: string;
}

// ──────────────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CACHE_DIR = path.resolve(__dirname, "..", "..", "cache", "twilio_lookup");

// ──────────────────────────────────────────────────────────────────────────
//  TYPE NORMALIZATION
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map Twilio's granular line_type_intelligence.type to our 4-bucket enum.
 * Twilio docs (as of 2025) define: landline, mobile, fixedVoip,
 * nonFixedVoip, personal, tollFree, premium, sharedCost, uan, voicemail.
 * Conservatism rule: if we can't classify it, return "unknown" — never
 * silently default to a positive bucket.
 */
export function normalizeLineType(raw: string | null | undefined): NormalizedLineType {
  if (!raw || typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (s === "landline") return "landline";
  if (s === "mobile") return "mobile";
  // Both VoIP variants — fixedVoip is e.g. corporate VoIP PBX, less
  // disposable than nonFixedVoip but still treat as voip from a TCPA
  // collectability standpoint (both reach the carrier through a
  // reseller, both can be ported quickly, neither has the carrier-level
  // anti-spoof guarantees of a true landline).
  if (s === "fixedvoip" || s === "nonfixedvoip" || s === "voip") return "voip";
  // Toll-free, personal, premium, sharedCost, uan, voicemail — exotic
  // categories that don't map cleanly onto landline/mobile/voip. Mark
  // unknown and let evaluateEnrichment skip the signal.
  return "unknown";
}

// ──────────────────────────────────────────────────────────────────────────
//  CACHE
// ──────────────────────────────────────────────────────────────────────────

function ensureCacheDir(): boolean {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn("[twilioLookup] Cache dir create failed:", (err as Error).message);
    return false;
  }
}

function cacheKey(e164: string): string {
  return crypto.createHash("sha256").update("v1:" + e164).digest("hex");
}

interface CacheEnvelope { cachedAt: number; result: LineLookupResult }

function readCache(key: string): LineLookupResult | null {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    const env = JSON.parse(fs.readFileSync(p, "utf-8")) as CacheEnvelope;
    if (!env || typeof env.cachedAt !== "number") return null;
    if (Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
    if (env.result.status === "match") {
      return { ...env.result, fromCache: true };
    }
    return env.result;
  } catch {
    return null;
  }
}

function writeCache(key: string, result: LineLookupResult): void {
  if (result.status !== "match") return; // never cache transient failures
  if (!ensureCacheDir()) return;
  try {
    const env: CacheEnvelope = { cachedAt: Date.now(), result };
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(env, null, 2), "utf-8");
  } catch (err) {
    console.warn("[twilioLookup] Cache write failed:", (err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  PUBLIC ENTRY POINT
// ──────────────────────────────────────────────────────────────────────────

export interface LookupOptions {
  forceRefresh?: boolean;
  enableNetwork?: boolean;
}

/**
 * Validate and normalize a phone number to E.164. Returns null if the
 * input doesn't look like a phone number we can ship to Twilio.
 *
 * Twilio Lookup expects a valid E.164 (+1XXXXXXXXXX). Our offender
 * normalizedNumber is already +1XXXXXXXXXX in the happy path, but we
 * defensively validate.
 */
function toE164(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Strip everything but digits and the leading +
  const plus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (s.length < 10 || s.length > 15) return null;
  // If the offender came in as 10 digits (NANPA without country code),
  // assume +1.
  if (!plus && s.length === 10) return "+1" + s;
  return "+" + s;
}

/**
 * Look up line-type intelligence for an offender phone number. Never throws.
 */
export async function lookupLineType(
  rawPhone: string,
  opts: LookupOptions = {}
): Promise<LineLookupResult> {
  const e164 = toE164(rawPhone);
  if (!e164) {
    return { status: "skipped", reason: `Phone "${rawPhone}" is not a valid E.164 number.` };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) {
    return {
      status: "skipped",
      reason: "Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).",
    };
  }

  const key = cacheKey(e164);
  if (!opts.forceRefresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const enableNetwork = opts.enableNetwork ?? true;
  if (!enableNetwork) {
    return { status: "skipped", reason: "Network lookup disabled." };
  }

  // Twilio SDK call
  let raw: any;
  try {
    const client = twilio(sid, tok);
    raw = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: "line_type_intelligence" });
  } catch (err: any) {
    const status = err?.status;
    const code = err?.code;
    return {
      status: "error",
      errorMessage:
        `Twilio Lookup failed${status ? ` (HTTP ${status})` : ""}` +
        `${code ? ` [code ${code}]` : ""}: ${err?.message ?? String(err)}`,
    };
  }

  const lti = raw?.lineTypeIntelligence ?? raw?.line_type_intelligence ?? null;
  const result: LineLookupMatch = {
    status: "match",
    normalizedType: normalizeLineType(lti?.type ?? null),
    rawType: lti?.type ?? null,
    carrierName: lti?.carrier_name ?? lti?.carrierName ?? null,
    mobileCountryCode: lti?.mobile_country_code ?? lti?.mobileCountryCode ?? null,
    mobileNetworkCode: lti?.mobile_network_code ?? lti?.mobileNetworkCode ?? null,
    countryCode: raw?.countryCode ?? raw?.country_code ?? null,
    lookedUpAt: new Date().toISOString(),
    fromCache: false,
  };
  writeCache(key, result);
  return result;
}
