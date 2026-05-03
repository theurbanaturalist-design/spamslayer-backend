// ─────────────────────────────────────────────────────────────────────────────
//  courtListenerClient.ts
//
//  On-demand CourtListener / RECAP wrapper. Searches the federal court
//  records for prior litigation involving a defendant company.
//
//  WHY THIS MATTERS — STRONGEST SINGLE OUTCOME PREDICTOR
//    For TCPA cases, prior-litigation count is the single best single
//    signal we can get on a defendant. A company that's been sued 47
//    times will probably settle yours too. A company with zero hits
//    might fight, default, or vanish — the variance is enormous.
//
//    Bucketed scoring (calibrated against existing 30-baseline):
//      0 prior hits          → no signal (could be brand new shell, or
//                              just first-time)
//      1-2 prior hits        → +8   (reachable, has counsel, has pattern)
//      3-10 prior hits       → +15  (serial violator, very reachable)
//      11+ prior hits        → +20  (known repeat defendant — near-certain
//                              to respond, almost always settles small claims)
//
//  ARCHITECTURE
//    • Pure async function. Never throws.
//    • 30-day disk cache (litigation data changes faster than entity
//      status — new cases are filed weekly).
//    • Optional COURTLISTENER_API_KEY env var for higher rate limits.
//      Without a key, we use the unauthenticated tier (which works but
//      is more aggressively rate-limited).
//
//  IMPORTANT LIMITS
//    CourtListener / RECAP only indexes FEDERAL court records. State-court
//    TCPA suits (and the small-claims TCPA suits this product helps users
//    file) are NOT indexed. So: a "0 prior hits" result doesn't mean the
//    defendant has never been sued — it means they've never been sued in
//    federal court. The UI must be honest about this limit.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";

// ──────────────────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────────────────

export type LitigationLookupResult =
  | LitigationMatch
  | LitigationNoMatch
  | LitigationSkipped
  | LitigationError;

export interface LitigationMatch {
  status: "match";
  /** Total federal-docket count for the query. */
  caseCount: number;
  /** Up to 5 sample case captions (truncated for display). */
  sampleCases: Array<{ caption: string; docketUrl: string | null; dateFiled: string | null; court: string | null }>;
  /** Public CourtListener search URL so the user can browse the full results themselves. */
  searchUrl: string;
  /** Verbatim query we sent (after normalization). */
  query: string;
  lookedUpAt: string;
  fromCache: boolean;
}

export interface LitigationNoMatch {
  status: "no_match";
  query: string;
  searchUrl: string;
  lookedUpAt: string;
  fromCache: boolean;
}

export interface LitigationSkipped {
  status: "skipped";
  reason: string;
}

export interface LitigationError {
  status: "error";
  errorMessage: string;
  httpStatus?: number;
}

// ──────────────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────────────

const COURT_LISTENER_API = "https://www.courtlistener.com/api/rest/v4/search/";
const COURT_LISTENER_BROWSE = "https://www.courtlistener.com/?";

// 30 days. Litigation data changes more often than entity status — new
// suits get filed weekly against active defendants — but a 30-day window
// is still a reasonable trade-off for a small-claims-prep product where
// users typically file within weeks of the lookup.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CACHE_DIR = path.resolve(__dirname, "..", "..", "cache", "courtlistener");

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_QUERY_LEN = 200;

// ──────────────────────────────────────────────────────────────────────────
//  QUERY CONSTRUCTION
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the search query string. We search RECAP dockets where the
 * defendant party-name matches AND the case content references TCPA.
 * Restricting to TCPA reduces false positives — a giant retailer might
 * have hundreds of unrelated suits that have nothing to do with our
 * defendant's robocall practices.
 */
function buildQuery(companyName: string): string {
  // Quote the company name so multi-word matches stay together. Strip
  // any double quotes the caller embedded to avoid breaking the syntax.
  const safe = companyName.replace(/"/g, "").trim().slice(0, MAX_QUERY_LEN);
  // The party_name field in CourtListener's RECAP index targets named
  // parties on the docket. Pair with TCPA keyword for relevance.
  return `party_name:"${safe}" AND (TCPA OR "Telephone Consumer Protection Act")`;
}

function buildSearchUrl(query: string): string {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("type", "r"); // RECAP / federal dockets
  return `${COURT_LISTENER_API}?${params.toString()}`;
}

function buildBrowseUrl(query: string): string {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("type", "r");
  return `${COURT_LISTENER_BROWSE}${params.toString()}`;
}

// ──────────────────────────────────────────────────────────────────────────
//  CACHE
// ──────────────────────────────────────────────────────────────────────────

function ensureCacheDir(): boolean {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn("[courtListener] Cache dir create failed:", (err as Error).message);
    return false;
  }
}

function cacheKey(query: string): string {
  return crypto.createHash("sha256").update("v1:" + query).digest("hex");
}

interface CacheEnvelope { cachedAt: number; result: LitigationLookupResult }

function readCache(key: string): LitigationLookupResult | null {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    const env = JSON.parse(fs.readFileSync(p, "utf-8")) as CacheEnvelope;
    if (!env || typeof env.cachedAt !== "number") return null;
    if (Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
    if (env.result.status === "match" || env.result.status === "no_match") {
      return { ...env.result, fromCache: true };
    }
    return env.result;
  } catch {
    return null;
  }
}

function writeCache(key: string, result: LitigationLookupResult): void {
  if (result.status !== "match" && result.status !== "no_match") return;
  if (!ensureCacheDir()) return;
  try {
    const env: CacheEnvelope = { cachedAt: Date.now(), result };
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(env, null, 2), "utf-8");
  } catch (err) {
    console.warn("[courtListener] Cache write failed:", (err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  HTTP
// ──────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(t);
  }
}

interface CourtListenerSearchResponse {
  count?: number;
  results?: Array<{
    caseName?: string;
    case_name?: string;
    docket_absolute_url?: string;
    absolute_url?: string;
    dateFiled?: string;
    date_filed?: string;
    court?: string;
    court_id?: string;
  }>;
}

// ──────────────────────────────────────────────────────────────────────────
//  PUBLIC ENTRY POINT
// ──────────────────────────────────────────────────────────────────────────

export interface LookupOptions {
  forceRefresh?: boolean;
  enableNetwork?: boolean;
}

export async function lookupPriorLitigation(
  rawCompanyName: string,
  opts: LookupOptions = {}
): Promise<LitigationLookupResult> {
  const trimmed = (rawCompanyName ?? "").toString().trim();
  if (!trimmed) {
    return { status: "skipped", reason: "No company name to search." };
  }
  if (trimmed.length < 3) {
    return { status: "skipped", reason: `Company name too short to look up: "${trimmed}".` };
  }

  const query = buildQuery(trimmed);
  const key = cacheKey(query);

  if (!opts.forceRefresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const enableNetwork = opts.enableNetwork ?? true;
  if (!enableNetwork) {
    return { status: "skipped", reason: "Network lookup disabled." };
  }

  const url = buildSearchUrl(query);
  const apiKey = process.env.COURTLISTENER_API_KEY;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "SpamSlayer/0.1 (+legal-aid)",
  };
  if (apiKey) headers["Authorization"] = `Token ${apiKey}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, headers);
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? `CourtListener request timed out after ${REQUEST_TIMEOUT_MS}ms.`
      : `CourtListener request failed: ${err?.message ?? String(err)}`;
    return { status: "error", errorMessage: msg };
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* swallow */ }
    return {
      status: "error",
      httpStatus: res.status,
      errorMessage: `CourtListener returned HTTP ${res.status}${detail ? ": " + detail : ""}`,
    };
  }

  let body: CourtListenerSearchResponse;
  try {
    body = (await res.json()) as CourtListenerSearchResponse;
  } catch (err: any) {
    return { status: "error", errorMessage: `CourtListener returned invalid JSON: ${err?.message ?? String(err)}` };
  }

  const browseUrl = buildBrowseUrl(query);
  const count = typeof body.count === "number" ? body.count : (body.results?.length ?? 0);

  if (count === 0 || !Array.isArray(body.results) || body.results.length === 0) {
    const result: LitigationNoMatch = {
      status: "no_match",
      query,
      searchUrl: browseUrl,
      lookedUpAt: new Date().toISOString(),
      fromCache: false,
    };
    writeCache(key, result);
    return result;
  }

  // Take up to 5 sample cases for display. Be defensive about CourtListener
  // sometimes returning camelCase, sometimes snake_case across endpoints.
  const sampleCases = body.results.slice(0, 5).map((r) => {
    const caption = (r.caseName ?? r.case_name ?? "Unknown caption").toString().slice(0, 200);
    const docketRel = r.docket_absolute_url ?? r.absolute_url ?? null;
    const docketUrl = docketRel
      ? (docketRel.startsWith("http") ? docketRel : `https://www.courtlistener.com${docketRel}`)
      : null;
    const dateFiled = (r.dateFiled ?? r.date_filed ?? null) as string | null;
    const court = (r.court ?? r.court_id ?? null) as string | null;
    return { caption, docketUrl, dateFiled, court };
  });

  const result: LitigationMatch = {
    status: "match",
    caseCount: count,
    sampleCases,
    searchUrl: browseUrl,
    query,
    lookedUpAt: new Date().toISOString(),
    fromCache: false,
  };
  writeCache(key, result);
  return result;
}
