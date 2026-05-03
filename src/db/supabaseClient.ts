// ─────────────────────────────────────────────────────────────────────
// supabaseClient.ts — Thin wrapper around @supabase/supabase-js
//
// This module is the ONLY place the backend talks to Supabase. Every
// other file should import the typed helpers exported here, not the
// raw createClient.
//
// Key safety properties:
//   1. The service-role key bypasses Row Level Security. It MUST stay
//      server-side. Never expose it to the frontend or any HTTP response.
//      All write paths in this file use the service-role client and
//      explicitly pass user_id so RLS-equivalent enforcement is encoded
//      in the query, not just relied on at the database layer.
//   2. If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing at
//      startup, getSupabaseClient() returns null. Callers must handle
//      the null case — nothing throws. This lets the existing
//      cases.json codepath keep working when Supabase isn't configured
//      (e.g. local dev, the dinner-demo machine).
//   3. All read helpers in this file are scoped by user_id. There is no
//      "list everything" helper — every query takes a userId so a bug
//      can't accidentally return another user's data.
//   4. This file does not implement WRITE helpers yet. That's a
//      follow-up — once writes are wired, the same user_id discipline
//      applies plus an explicit write audit trail (planned).
// ─────────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import type { OffenderProfile, CallEntry } from "../services/caseBuilder";

export type SpamSlayerSupabase = SupabaseClient<Database>;

let cachedClient: SpamSlayerSupabase | null | undefined = undefined;

/**
 * Returns a Supabase client configured with the service-role key, or
 * null if the required env vars are not set. Callers MUST handle the
 * null case — this is intentional so the app degrades gracefully when
 * Supabase isn't configured.
 *
 * The client is cached after first call; if you change env vars at
 * runtime (you shouldn't), call resetSupabaseClient() to clear it.
 */
export function getSupabaseClient(): SpamSlayerSupabase | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn(
      "[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — " +
      "Supabase backend disabled. Set CASES_BACKEND=json to suppress this warning."
    );
    cachedClient = null;
    return null;
  }

  // Defensive: refuse to use a key that looks like the anon key on the
  // server. The service-role JWT has role:"service_role" in its payload;
  // anon has role:"anon". We don't decode the JWT here, but we do check
  // that the key wasn't accidentally swapped with the URL, and we log
  // a hint so misconfigurations are obvious.
  if (key === url || key.length < 40) {
    console.error(
      "[Supabase] SUPABASE_SERVICE_ROLE_KEY looks malformed. Refusing to start client."
    );
    cachedClient = null;
    return null;
  }

  cachedClient = createClient<Database>(url, key, {
    auth: {
      // Server-side: never persist sessions, never auto-refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
  });

  console.log("[Supabase] Client initialized for", url);
  return cachedClient;
}

/** Test seam: forget the cached client. Used by unit tests. */
export function resetSupabaseClient(): void {
  cachedClient = undefined;
}

/** Returns true if Supabase is configured and reachable (env-var presence only). */
export function isSupabaseConfigured(): boolean {
  return getSupabaseClient() !== null;
}

// ─── Row → domain mapping ────────────────────────────────────────────
//
// The existing OffenderProfile shape (camelCase, inlined calls array)
// differs from the Postgres row shape (snake_case, separate calls table).
// These mappers translate between the two so the rest of the app sees
// a consistent OffenderProfile regardless of backend.

type OffenderRow = Database["public"]["Tables"]["offenders"]["Row"];
type CallRow = Database["public"]["Tables"]["calls"]["Row"];

function rowToCallEntry(row: CallRow): CallEntry {
  return {
    date: row.call_date,
    time: row.call_time,
    callSid: row.call_sid,
    subscriberId: row.user_id,
    recordingUrl: row.recording_url,
    transcriptSnippet: row.transcript_snippet,
    callType: row.call_type,
  };
}

/**
 * Map a Postgres offender row (with its joined calls) to the domain
 * OffenderProfile shape used by the rest of the backend.
 *
 * NOTE: subscriberIds is reconstructed from the calls' user_ids because
 * the offender row itself only carries one user_id (the owner). In the
 * cases.json model an offender can be shared across subscribers; in the
 * Postgres model each user has their own offender row, so subscriberIds
 * will always be a single-element array containing the owner's user_id.
 */
export function rowToOffenderProfile(
  row: OffenderRow & { calls?: CallRow[] | null }
): OffenderProfile {
  const calls = (row.calls ?? []).map(rowToCallEntry);
  // Sort by date+time ascending — the cases.json model treats calls as
  // append-order, and the legalFilingGenerator expects chronological order.
  calls.sort((a, b) => {
    const ad = `${a.date}T${a.time}`;
    const bd = `${b.date}T${b.time}`;
    return ad.localeCompare(bd);
  });

  return {
    normalizedNumber: row.normalized_number,
    rawNumbers: row.raw_numbers ?? [],
    companyName: row.company_name,
    callerNames: row.caller_names ?? [],
    purpose: row.purpose,
    callCount: calls.length,
    calls,
    firstCallDate: row.first_call_date,
    lastCallDate: row.last_call_date,
    actionable: row.actionable,
    willful: row.willful,
    damagesEstimate: row.damages_estimate,
    demandLetterSent: row.demand_letter_sent,
    demandLetterDate: row.demand_letter_date,
    subscriberIds: [row.user_id],
    filedAt: row.filed_at,
    filedCaseRef: row.filed_case_ref,
  };
}

// ─── Read helpers (user-scoped) ──────────────────────────────────────
//
// Every helper takes a userId. There is no "list everything" — that
// would be a footgun. If you're scripting an admin export, write a
// dedicated admin helper with an audit log.

/**
 * Fetch all offenders for a user, with their calls inlined.
 * Excludes continuation profiles (parent_offender_id IS NOT NULL) by default.
 */
export async function listOffendersForUser(
  userId: string,
  opts: { includeContinuations?: boolean } = {}
): Promise<OffenderProfile[]> {
  const sb = getSupabaseClient();
  if (!sb) return [];

  let query = sb
    .from("offenders")
    .select("*, calls(*)")
    .eq("user_id", userId);

  if (!opts.includeContinuations) {
    query = query.is("parent_offender_id", null);
  }

  const { data, error } = await query.order("last_call_date", { ascending: false });

  if (error) {
    console.error("[Supabase] listOffendersForUser failed:", error);
    return [];
  }

  return (data ?? []).map(rowToOffenderProfile);
}

/**
 * Fetch a single offender for a user by normalized phone number.
 * Returns null if not found. Returns the primary (non-continuation) row.
 */
export async function getOffenderForUser(
  userId: string,
  normalizedNumber: string
): Promise<OffenderProfile | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from("offenders")
    .select("*, calls(*)")
    .eq("user_id", userId)
    .eq("normalized_number", normalizedNumber)
    .is("parent_offender_id", null)
    .maybeSingle();

  if (error) {
    console.error(
      `[Supabase] getOffenderForUser(${userId}, ${normalizedNumber}) failed:`,
      error
    );
    return null;
  }

  return data ? rowToOffenderProfile(data) : null;
}

/**
 * Fetch only the actionable (filable) offenders for a user.
 * Excludes already-filed offenders by default (matches the Dashboard's
 * "Ready to file" semantics).
 */
export async function listActionableOffendersForUser(
  userId: string,
  opts: { includeFiled?: boolean } = {}
): Promise<OffenderProfile[]> {
  const sb = getSupabaseClient();
  if (!sb) return [];

  let query = sb
    .from("offenders")
    .select("*, calls(*)")
    .eq("user_id", userId)
    .eq("actionable", true)
    .is("parent_offender_id", null);

  if (!opts.includeFiled) {
    query = query.is("filed_at", null);
  }

  const { data, error } = await query.order("damages_estimate", { ascending: false });

  if (error) {
    console.error("[Supabase] listActionableOffendersForUser failed:", error);
    return [];
  }

  return (data ?? []).map(rowToOffenderProfile);
}

/** Health check: confirms we can reach the database and read auth.users count. */
export async function pingSupabase(): Promise<{ ok: boolean; detail: string }> {
  const sb = getSupabaseClient();
  if (!sb) return { ok: false, detail: "Client not configured" };

  // count head request — minimal payload, no row data leaked
  const { error, count } = await sb
    .from("offenders")
    .select("*", { count: "exact", head: true });

  if (error) return { ok: false, detail: error.message };
  return { ok: true, detail: `offenders count = ${count ?? 0}` };
}
