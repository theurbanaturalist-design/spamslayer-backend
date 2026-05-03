// ─────────────────────────────────────────────────────────────────────────────
//  openCorporatesClient.ts
//
//  Thin wrapper around the OpenCorporates company-search API. This is a PoC
//  for the "is this a real, in-good-standing entity?" enrichment signal that
//  feeds into defendantResearch.ts → CollectabilityScore.
//
//  ARCHITECTURE
//    • Pure async function with no side effects on the caller's state
//      besides a local disk cache under backend/cache/opencorporates/.
//    • Never throws. All failure modes are returned as discriminated-union
//      values so the caller can render a precise UI message and so the
//      scoring layer can distinguish "queried and got nothing" from
//      "couldn't query at all". This distinction is critical because the
//      product-decision (per Marcus 2026-04-18) is to PENALIZE not_found
//      but NOT penalize error/skipped — a wrong API call shouldn't sink an
//      otherwise good case.
//
//  LEGAL-ACCURACY DISCIPLINE
//    The petition is sworn. We are NOT going to put the OpenCorporates
//    matched-name into the petition automatically. Enrichment feeds a
//    SCORE shown to the user — the user remains responsible for putting
//    the right defendant name into their filing. Comments below reinforce
//    this separation.
//
//  PRIVACY
//    The only thing leaving the box is the COMPANY NAME (publicly
//    advertised by the caller themselves) and an optional jurisdiction
//    code. No phone numbers, no user PII, no transcripts.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";

// ──────────────────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalized status across jurisdictions. OpenCorporates returns raw
 * jurisdiction-specific strings ("Active", "Live", "Dissolved", "Forfeited
 * - Failure to File Annual Report", etc). We collapse these to a small
 * enum so downstream scoring isn't a giant switch statement.
 *
 * If we genuinely cannot tell, we use "unknown" — never silently default
 * to "active". A misclassified dissolved entity could lead a user into a
 * fight they can't win.
 */
export type NormalizedEntityStatus =
  | "active"      // operating, in good standing
  | "inactive"    // registered but not currently operating (suspended, withdrawn, in process)
  | "dissolved"   // dead — terminated, expired, cancelled, merged out
  | "unknown";    // OpenCorporates returned a status we don't recognize

/**
 * Result of a single registry lookup.
 *
 * status:
 *   "match"       — found a company. matchedName / company_number / status
 *                   are populated.
 *   "no_match"    — query succeeded, registry returned zero results.
 *                   This is what triggers the user-chosen "penalize"
 *                   collectability signal. No matchedName.
 *   "skipped"     — we did not query (no API key configured AND/OR feature
 *                   gated). NO scoring impact.
 *   "error"       — we tried to query and something went wrong (network,
 *                   rate limit, bad response). NO scoring impact. The
 *                   `errorMessage` is for the user, not for the petition.
 *
 * The discriminator is `status`. TypeScript will help downstream code
 * handle every branch.
 */
export type EntityLookupResult =
  | EntityLookupMatch
  | EntityLookupNoMatch
  | EntityLookupSkipped
  | EntityLookupError;

export interface EntityLookupMatch {
  status: "match";
  /**
   * The exact name string returned by OpenCorporates. Surfacing this lets
   * the user verify that the registry hit is actually their defendant
   * (e.g. "ACME WARRANTY LLC" vs "Acme Warranty Group, LLC" — same idea,
   * different filings).
   */
  matchedName: string;
  /** OpenCorporates company_number (filing number in source registry). */
  companyNumber: string;
  /** Source jurisdiction (e.g. "us_la"). */
  jurisdictionCode: string;
  /** Normalized current registration status. See NormalizedEntityStatus. */
  normalizedStatus: NormalizedEntityStatus;
  /** Verbatim raw status string from OpenCorporates, for display. */
  rawStatus: string | null;
  /** ISO date the entity was incorporated, if reported. */
  incorporationDate: string | null;
  /** Free-text registered address from registry, if reported. */
  registeredAddress: string | null;
  /** Public OpenCorporates URL so the user can verify themselves. */
  sourceUrl: string;
  /** ISO timestamp this lookup was performed (or pulled from cache). */
  lookedUpAt: string;
  /** True if we returned this from local cache, not a fresh API call. */
  fromCache: boolean;
  /**
   * Indicator for the UI: how confident the name match is.
   *  - "exact"       — normalized strings match
   *  - "high"        — one is a prefix/substring of the other after suffix-stripping
   *  - "low"         — top hit but names differ substantially
   * Senior users need to SEE this so they don't take a wrong-defendant
   * suggestion for granted.
   */
  matchConfidence: "exact" | "high" | "low";
}

export interface EntityLookupNoMatch {
  status: "no_match";
  /** Normalized query we sent. Useful for "we searched 'X' and found nothing". */
  query: string;
  jurisdictionCode: string | null;
  lookedUpAt: string;
  fromCache: boolean;
}

export interface EntityLookupSkipped {
  status: "skipped";
  reason: string;
}

export interface EntityLookupError {
  status: "error";
  errorMessage: string;
  /** HTTP status code if the failure was at the response layer. */
  httpStatus?: number;
}

// ──────────────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────────────

const OPENCORPORATES_BASE = "https://api.opencorporates.com/v0.4/companies/search";

// 90 days. Entity-status changes are rare enough that 90 days is a
// reasonable cache window for a small-claims context (cases take weeks
// to file anyway). Annual reports are once a year, so a 90-day window
// will catch most status changes within a single quarter.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const CACHE_DIR = path.resolve(__dirname, "..", "..", "cache", "opencorporates");

const REQUEST_TIMEOUT_MS = 8_000;

const MAX_QUERY_LEN = 100;

// ──────────────────────────────────────────────────────────────────────────
//  NAME NORMALIZATION
// ──────────────────────────────────────────────────────────────────────────

/**
 * Suffixes to strip when comparing names. Mirrors (and extends) the list
 * in defendantResearch.ts. Kept local so the two modules can evolve
 * independently — registry-name normalization is a different problem
 * than scoring-time normalization.
 */
const NORMALIZE_SUFFIXES = [
  "limited liability company", "llc", "l.l.c.", "l l c",
  "incorporated", "inc.", "inc",
  "corporation", "corp.", "corp",
  "company", "co.", "co",
  "limited", "ltd.", "ltd",
  "lp", "llp", "lllp",
  "group", "holdings",
  "the",
];

/**
 * Lowercase, strip punctuation, collapse whitespace, and remove common
 * entity suffixes. This is what we use as the cache key AND what we use
 * for the matchConfidence comparison.
 */
export function normalizeNameForLookup(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.toLowerCase();
  // Strip control + zero-width chars defensively.
  s = s.replace(/[\u0000-\u001F\u007F]/g, " ");
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
  // Strip punctuation except internal hyphens/apostrophes which can be
  // part of a real name. We re-strip apostrophes after suffix removal.
  s = s.replace(/[^\w\s\-']/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Strip suffixes (longest first so "limited liability company" beats "limited").
  const sorted = [...NORMALIZE_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suf of sorted) {
    const re = new RegExp("(\\s|^)" + suf.replace(/[.\\]/g, "\\$&") + "(\\s|$)", "g");
    s = s.replace(re, " ");
  }
  s = s.replace(/['\.]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function compareNames(query: string, candidate: string): "exact" | "high" | "low" {
  const q = normalizeNameForLookup(query);
  const c = normalizeNameForLookup(candidate);
  if (!q || !c) return "low";
  if (q === c) return "exact";
  // "high" if one contains the other with reasonable length parity.
  if (q.length >= 4 && c.length >= 4) {
    if (c.includes(q) || q.includes(c)) {
      const ratio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
      if (ratio >= 0.6) return "high";
    }
  }
  return "low";
}

// ──────────────────────────────────────────────────────────────────────────
//  STATUS NORMALIZATION
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map raw OpenCorporates status strings to our four-bucket enum.
 * Exhaustive-ish for US jurisdictions; conservative on edges.
 *
 * If we can't classify a status, we return "unknown" — NEVER guess
 * "active". The downstream scoring code treats "unknown" as no entity
 * signal at all, which is the safe default.
 */
export function normalizeRegistryStatus(raw: string | null | undefined): NormalizedEntityStatus {
  if (!raw || typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (!s) return "unknown";

  // Active / good-standing variants
  const ACTIVE = [
    "active", "live", "good standing", "in good standing", "in existence",
    "in business", "registered", "current", "current-active", "exists",
    "operating",
  ];
  if (ACTIVE.some((tag) => s === tag || s.startsWith(tag) || s.includes(" " + tag))) return "active";

  // Dissolved / terminated variants (DEAD)
  const DEAD = [
    "dissolved", "terminated", "expired", "cancelled", "canceled",
    "revoked", "forfeited", "forfeit", "merged", "withdrawn-merger",
    "ceased", "ceased trading", "struck off", "struck-off",
    "voluntary dissolution", "involuntary dissolution",
    "permanently revoked",
  ];
  if (DEAD.some((tag) => s.includes(tag))) return "dissolved";

  // Inactive / suspended (still on the books, not currently in business)
  const INACTIVE = [
    "inactive", "suspended", "delinquent", "withdrawn", "in liquidation",
    "in receivership", "administratively dissolved", "not in good standing",
    "pending", "pending dissolution", "in process",
  ];
  if (INACTIVE.some((tag) => s.includes(tag))) {
    // "administratively dissolved" is a tricky one — in many states the
    // entity is functionally dead but can sometimes reinstate. From a
    // small-claims-collectability standpoint, treat as dissolved.
    if (s.includes("administratively dissolved")) return "dissolved";
    return "inactive";
  }

  return "unknown";
}

// ──────────────────────────────────────────────────────────────────────────
//  CACHE
// ──────────────────────────────────────────────────────────────────────────

function ensureCacheDir(): boolean {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    return true;
  } catch (err) {
    console.warn("[openCorporates] Could not create cache dir:", (err as Error).message);
    return false;
  }
}

function cacheKey(query: string, jurisdictionCode: string | null): string {
  const payload = JSON.stringify({ q: normalizeNameForLookup(query), j: jurisdictionCode ?? "" });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function cachePathFor(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

interface CacheEnvelope {
  cachedAt: number;        // ms since epoch
  result: EntityLookupResult;
}

function readCache(key: string): EntityLookupResult | null {
  try {
    const p = cachePathFor(key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    const env = JSON.parse(raw) as CacheEnvelope;
    if (!env || typeof env.cachedAt !== "number" || !env.result) return null;
    if (Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
    // Mark as cache hit on read.
    if (env.result.status === "match" || env.result.status === "no_match") {
      return { ...env.result, fromCache: true } as EntityLookupResult;
    }
    return env.result;
  } catch {
    return null;
  }
}

function writeCache(key: string, result: EntityLookupResult): void {
  // Only cache deterministic outcomes (match / no_match). Errors and
  // skips might be transient and shouldn't be cached.
  if (result.status !== "match" && result.status !== "no_match") return;
  if (!ensureCacheDir()) return;
  try {
    const env: CacheEnvelope = { cachedAt: Date.now(), result };
    fs.writeFileSync(cachePathFor(key), JSON.stringify(env, null, 2), "utf-8");
  } catch (err) {
    console.warn("[openCorporates] Could not write cache:", (err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  HTTP
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the OpenCorporates search URL. We URL-encode every parameter and
 * never interpolate user input directly.
 */
function buildSearchUrl(query: string, jurisdictionCode: string | null): string {
  const params = new URLSearchParams();
  params.set("q", query);
  // OpenCorporates jurisdiction codes are lowercased two-or-five-letter
  // strings like "us_la" or "us". Validate before sending.
  if (jurisdictionCode && /^[a-z]{2}(_[a-z]{2})?$/.test(jurisdictionCode)) {
    params.set("jurisdiction_code", jurisdictionCode);
  }
  params.set("per_page", "5");
  // Order so most-relevant come first.
  params.set("order", "score");
  const apiKey = process.env.OPENCORPORATES_API_KEY;
  if (apiKey) params.set("api_token", apiKey);
  return `${OPENCORPORATES_BASE}?${params.toString()}`;
}

interface RawSearchResponse {
  results?: {
    companies?: Array<{
      company?: {
        name?: string;
        company_number?: string;
        jurisdiction_code?: string;
        current_status?: string | null;
        incorporation_date?: string | null;
        registered_address_in_full?: string | null;
        opencorporates_url?: string;
      };
    }>;
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json", "User-Agent": "SpamSlayer/0.1 (+legal-aid)" },
    });
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  PUBLIC ENTRY POINT
// ──────────────────────────────────────────────────────────────────────────

export interface LookupOptions {
  /**
   * OpenCorporates jurisdiction code (e.g. "us_la"). When provided, the
   * search is scoped to that jurisdiction. Recommended — it dramatically
   * reduces false positives across the 200+ jurisdictions in the registry.
   */
  jurisdictionCode?: string | null;
  /**
   * If true, bypass cache. Useful for forced refresh from the UI.
   */
  forceRefresh?: boolean;
  /**
   * Set to false to skip the network call entirely (for tests / offline
   * mode). Returns `{ status: "skipped" }`.
   */
  enableNetwork?: boolean;
}

/**
 * Look up an entity by name. Never throws.
 */
export async function lookupEntity(
  rawCompanyName: string,
  opts: LookupOptions = {}
): Promise<EntityLookupResult> {
  const enableNetwork = opts.enableNetwork ?? true;
  // Guardrail: empty / too-short names are not worth a query.
  const trimmed = (rawCompanyName ?? "").toString().trim();
  if (!trimmed) {
    return { status: "skipped", reason: "No company name provided." };
  }
  if (trimmed.length < 3) {
    return { status: "skipped", reason: `Company name too short to look up: "${trimmed}".` };
  }
  const query = trimmed.slice(0, MAX_QUERY_LEN);
  const jurisdictionCode = opts.jurisdictionCode
    ? opts.jurisdictionCode.trim().toLowerCase()
    : null;

  const key = cacheKey(query, jurisdictionCode);

  // Cache short-circuit
  if (!opts.forceRefresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  if (!enableNetwork) {
    return { status: "skipped", reason: "Network lookup disabled." };
  }

  // Network call
  const url = buildSearchUrl(query, jurisdictionCode);
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? `OpenCorporates request timed out after ${REQUEST_TIMEOUT_MS}ms.`
      : `OpenCorporates request failed: ${err?.message ?? String(err)}`;
    return { status: "error", errorMessage: msg };
  }

  if (!res.ok) {
    // 401 = bad API key, 403 = quota, 429 = rate limit, 5xx = upstream
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* swallow */ }
    return {
      status: "error",
      httpStatus: res.status,
      errorMessage: `OpenCorporates returned HTTP ${res.status}${detail ? ": " + detail : ""}`,
    };
  }

  let body: RawSearchResponse;
  try {
    body = (await res.json()) as RawSearchResponse;
  } catch (err: any) {
    return { status: "error", errorMessage: `OpenCorporates returned invalid JSON: ${err?.message ?? String(err)}` };
  }

  const companies = body?.results?.companies ?? [];
  if (!Array.isArray(companies) || companies.length === 0) {
    const result: EntityLookupNoMatch = {
      status: "no_match",
      query,
      jurisdictionCode,
      lookedUpAt: new Date().toISOString(),
      fromCache: false,
    };
    writeCache(key, result);
    return result;
  }

  // Take the top result (search is sorted by score). Guardrail: skip
  // entries that don't even have a name.
  const hit = companies.find((c) => c?.company?.name && typeof c.company.name === "string");
  if (!hit || !hit.company || !hit.company.name) {
    const result: EntityLookupNoMatch = {
      status: "no_match",
      query,
      jurisdictionCode,
      lookedUpAt: new Date().toISOString(),
      fromCache: false,
    };
    writeCache(key, result);
    return result;
  }

  const c = hit.company;
  const matchConfidence = compareNames(query, c.name as string);

  const result: EntityLookupMatch = {
    status: "match",
    matchedName: (c.name as string).slice(0, 200),
    companyNumber: (c.company_number ?? "").toString().slice(0, 100),
    jurisdictionCode: (c.jurisdiction_code ?? jurisdictionCode ?? "").toString().slice(0, 20),
    normalizedStatus: normalizeRegistryStatus(c.current_status ?? null),
    rawStatus: c.current_status ? c.current_status.toString().slice(0, 200) : null,
    incorporationDate: c.incorporation_date ? c.incorporation_date.toString().slice(0, 20) : null,
    registeredAddress: c.registered_address_in_full
      ? c.registered_address_in_full.toString().slice(0, 500)
      : null,
    sourceUrl: c.opencorporates_url
      ? c.opencorporates_url.toString().slice(0, 500)
      : `https://opencorporates.com/companies?jurisdiction_code=${encodeURIComponent(jurisdictionCode ?? "")}&q=${encodeURIComponent(query)}`,
    lookedUpAt: new Date().toISOString(),
    fromCache: false,
    matchConfidence,
  };

  writeCache(key, result);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute years between an incorporation date (YYYY-MM-DD) and today.
 * Returns null if the date is unparseable. Defensive against future
 * dates (returns 0 — never negative).
 */
export function entityAgeYears(incorporationDate: string | null | undefined): number | null {
  if (!incorporationDate) return null;
  const d = new Date(incorporationDate);
  if (isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Build the OpenCorporates jurisdiction code for a US 2-letter state
 * abbreviation. e.g. "LA" → "us_la". Returns null if the input doesn't
 * look like a US state.
 */
export function jurisdictionCodeFromUsState(state: string | null | undefined): string | null {
  if (!state || typeof state !== "string") return null;
  const s = state.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(s)) return null;
  return `us_${s}`;
}
