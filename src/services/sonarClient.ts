// ─────────────────────────────────────────────────────────────────────────────
//  sonarClient.ts — Perplexity Sonar API wrapper for defendant web research
//
//  Mirrors the architecture of twilioLookupClient.ts and openCorporatesClient.ts:
//    - Pure async function. Never throws.
//    - Discriminated-union result so the caller can distinguish "match" /
//      "skipped" (no API key, etc.) / "error" (network, rate limit, bad
//      response). Same vocabulary as the other research clients so callers
//      can handle them uniformly.
//    - 30-day disk cache keyed by SHA-256 of (model + prompt + company) so
//      repeated lookups for the same defendant don't re-bill the account.
//      News changes faster than entity status, but for SpamSlayer's scale
//      30 days is the right tradeoff.
//
//  WHEN TO CALL THIS
//    Sonar is the UNSTRUCTURED-research layer. Use it for questions no
//    single dedicated API answers cleanly:
//      - "Has [Defendant] been mentioned in FCC enforcement actions in the
//         last 12 months?"
//      - "What's the registered agent for [Defendant LLC] in [State]?"
//      - "Have any 2025-2026 TCPA cases narrowed [Precedent]?"
//
//    Use openCorporatesClient for entity status, courtListenerClient for
//    federal litigation count, twilioLookupClient for line type. Don't
//    duplicate those with Sonar — the dedicated clients are authoritative
//    for what they cover and most are free.
//
//  COST MODEL (May 2026 pricing, confirmed via api.perplexity.ai)
//    - sonar (base):              ~$0.005 request fee + tokens (typical $0.005-$0.01/query)
//    - sonar-pro:                 ~$0.006 request fee + higher token rates
//    - sonar-reasoning-pro:       ~$0.008 request fee + reasoning tokens
//    - sonar-deep-research:       ~$0.41/query — synthesizes multiple sources,
//                                 use only for pre-filing case prep
//
//    SpamSlayer's policy: fire base "sonar" automatically when a case
//    becomes actionable (~$0.01 per case). Manual escalation to
//    sonar-deep-research is gated behind an explicit `deep` opt-in for
//    callers that want the high-quality version (e.g., right before saving
//    a filing package). Per-call default keeps cost in low cents per case.
//
//  PRIVACY
//    Only the COMPANY NAME (publicly advertised by the caller) and the
//    research prompt template leave the box. No phone numbers, transcripts,
//    or user PII.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────

export type SonarLookupResult =
  | SonarMatch
  | SonarSkipped
  | SonarError;

export interface SonarMatch {
  status: "match";
  /** Synthesized prose answer from Sonar (1-3 paragraphs typically). */
  summary: string;
  /** URLs Sonar cited as sources. May be empty for some queries. */
  citations: string[];
  /** Search results metadata when present (title/url/date triples). */
  searchResults?: Array<{ title: string; url: string; date?: string | null }>;
  /** Model that handled the request. */
  model: string;
  /** Total cost of this request in USD per Perplexity's response.usage.cost.total_cost. */
  costUsd: number;
  lookedUpAt: string;
  fromCache: boolean;
}

export interface SonarSkipped {
  status: "skipped";
  reason: string;
}

export interface SonarError {
  status: "error";
  httpStatus?: number;
  errorMessage: string;
}

export interface SonarLookupOptions {
  /** Force a fresh fetch even if cache is hot. */
  forceRefresh?: boolean;
  /** Override the model. Defaults to env PERPLEXITY_MODEL or "sonar". */
  model?: string;
  /** When true, bypass cache for this call. Useful for forced re-research. */
  noCache?: boolean;
  /** Override the system prompt — for callers that want a custom framing. */
  systemPrompt?: string;
  /** Cap output tokens. Defaults to 600 (1-3 paragraphs). */
  maxTokens?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const API_URL = "https://api.perplexity.ai/chat/completions";
const REQUEST_TIMEOUT_MS = 45_000;        // Sonar deep queries can take >30s
const CACHE_DIR = path.resolve(__dirname, "..", "..", "cache", "sonar");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const DEFAULT_SYSTEM_PROMPT =
  "You are a research assistant helping a small-claims TCPA plaintiff identify a " +
  "defendant company. Return concise, factual prose with inline source citations. " +
  "If you cannot find authoritative information, say so plainly — do not invent " +
  "details. Focus on: regulatory history (FCC/FTC/state-AG actions), corporate " +
  "registration status, prior consumer complaints, news coverage of TCPA or " +
  "telemarketing-related conduct. Skip marketing fluff from the company's own site.";

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEnvelope { cachedAt: number; result: SonarMatch }

function ensureCacheDir(): boolean {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn("[sonar] cache dir create failed:", (err as Error).message);
    return false;
  }
}

function cacheKey(model: string, company: string, customPrompt: string): string {
  return crypto
    .createHash("sha256")
    .update(`v1:${model}:${company.toLowerCase().trim()}:${customPrompt.slice(0, 200)}`)
    .digest("hex");
}

function readCache(key: string): SonarMatch | null {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    const env = JSON.parse(fs.readFileSync(p, "utf-8")) as CacheEnvelope;
    if (!env || typeof env.cachedAt !== "number") return null;
    if (Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
    return { ...env.result, fromCache: true };
  } catch { return null; }
}

function writeCache(key: string, result: SonarMatch): void {
  if (!ensureCacheDir()) return;
  try {
    const env: CacheEnvelope = { cachedAt: Date.now(), result };
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(env, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn("[sonar] cache write failed:", (err as Error).message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run a Sonar query about a defendant company. Cached for 30 days. Never throws.
 *
 * @param companyName  The defendant's name as captured from the call.
 * @param question     The specific research question (will be combined with
 *                     a default system prompt focused on TCPA defendant research).
 */
export async function researchDefendant(
  companyName: string,
  question: string,
  opts: SonarLookupOptions = {}
): Promise<SonarLookupResult> {
  const company = (companyName ?? "").trim();
  if (!company) return { status: "skipped", reason: "No company name to research." };
  if (company.length < 3) return { status: "skipped", reason: `Company name too short: "${company}".` };

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "PERPLEXITY_API_KEY not set." };

  const model = opts.model ?? process.env.PERPLEXITY_MODEL ?? "sonar";
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userPrompt = `Defendant: ${company}\n\n${question}`;
  const maxTokens = opts.maxTokens ?? 600;

  const key = cacheKey(model, company, question);

  if (!opts.forceRefresh && !opts.noCache) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "SpamSlayer/0.1 (+legal-aid)",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
      }),
      signal: ac.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === "AbortError"
      ? `Perplexity request timed out after ${REQUEST_TIMEOUT_MS}ms.`
      : `Perplexity request failed: ${err?.message ?? String(err)}`;
    return { status: "error", errorMessage: msg };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* swallow */ }
    return {
      status: "error",
      httpStatus: res.status,
      errorMessage: `Perplexity returned HTTP ${res.status}${detail ? ": " + detail : ""}`,
    };
  }

  let body: any;
  try { body = await res.json(); }
  catch (err: any) {
    return { status: "error", errorMessage: `Perplexity returned invalid JSON: ${err?.message ?? String(err)}` };
  }

  const content: string | undefined = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { status: "error", errorMessage: "Perplexity returned no content." };
  }

  const result: SonarMatch = {
    status: "match",
    summary: content.trim(),
    citations: Array.isArray(body.citations) ? body.citations.slice(0, 20) : [],
    searchResults: Array.isArray(body.search_results)
      ? body.search_results.slice(0, 10).map((s: any) => ({
          title: typeof s.title === "string" ? s.title.slice(0, 200) : "",
          url: typeof s.url === "string" ? s.url : "",
          date: s.date ?? s.last_updated ?? null,
        }))
      : undefined,
    model: body.model ?? model,
    costUsd: typeof body?.usage?.cost?.total_cost === "number" ? body.usage.cost.total_cost : 0,
    lookedUpAt: new Date().toISOString(),
    fromCache: false,
  };

  writeCache(key, result);
  return result;
}

/**
 * Convenience wrapper: ask the standard "research this TCPA defendant"
 * question. Used by the per-actionable-case orchestration in /api/cases/log.
 */
export async function researchTcpaDefendant(
  companyName: string,
  opts: SonarLookupOptions = {}
): Promise<SonarLookupResult> {
  const question =
    "Provide a 2-paragraph briefing on this company for a TCPA small-claims " +
    "filing. Cover: (1) corporate identity — registered name, jurisdiction, " +
    "registered agent if available, parent or DBA relationships; (2) " +
    "regulatory and litigation history relevant to telemarketing — FCC/FTC " +
    "enforcement actions, state-AG complaints, prior TCPA suits, BBB " +
    "complaint volume. End with a one-line verdict on collectability " +
    "(\"reachable / shell entity / unknown\"). If sources contradict, note " +
    "the disagreement.";
  return researchDefendant(companyName, question, opts);
}

/**
 * Entity-identity-only Sonar query. Replaces the OpenCorporates lookup at
 * a fraction of the cost (~$0.005 vs ~$0.005-2.40 with OC). Returns a
 * focused prose answer about who this company is, where they're registered,
 * who their registered agent is (critical for service of process), and
 * whether they're currently in good standing.
 *
 * Why a separate prompt from researchTcpaDefendant: filer-facing UX wants
 * a tight answer to "where do I serve them?" — that's a smaller target
 * than the full TCPA briefing, which may bury the registered-agent answer
 * under regulatory-history paragraphs. Smaller prompt = lower token cost
 * AND a more usable answer for the practical question.
 *
 * Optionally accepts a userState (USPS code, e.g. "LA") so the prompt
 * nudges Sonar to check state-of-filing first before national searches.
 */
export async function researchEntityIdentity(
  companyName: string,
  userState?: string,
  opts: SonarLookupOptions = {}
): Promise<SonarLookupResult> {
  const stateNudge = userState
    ? ` Start with the ${userState.toUpperCase()} Secretary of State business search if the company appears to be registered there; if not, search nationally.`
    : "";
  const question =
    "Identify this company for service of process in a small-claims TCPA " +
    "filing. Provide:\n" +
    "  1. Exact registered name (and any DBAs/aliases)\n" +
    "  2. Jurisdiction of incorporation (state + entity type, e.g. \"Delaware LLC\")\n" +
    "  3. Registered agent name and street address — this is what the user needs to serve the petition\n" +
    "  4. Current registration status (active / dissolved / forfeited / unknown)\n" +
    "  5. If the company has multiple entities sharing this name, flag the ambiguity\n\n" +
    "Be concise. If you can't find authoritative info on a field, write " +
    "\"not found\" — do not guess. Cite the state SoS URL where you found " +
    "each fact." + stateNudge;
  return researchDefendant(companyName, question, { ...opts, maxTokens: 400 });
}
