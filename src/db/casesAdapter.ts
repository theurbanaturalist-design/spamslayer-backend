// ─────────────────────────────────────────────────────────────────────
// casesAdapter.ts — Feature-flagged read surface over cases.json OR Supabase
//
// This is the bridge that lets us migrate caseBuilder's read paths from
// the local JSON file to Postgres without a big-bang rewrite.
//
// Routing:
//   CASES_BACKEND=json       → reads from cases.json via caseBuilder (default)
//   CASES_BACKEND=supabase   → reads from Postgres via supabaseClient
//
// The adapter exposes ONLY read functions right now. Writes (logCall,
// markOffenderFiled, markDemandSent) continue to go through caseBuilder
// until the write path is migrated in a later session. This intentional
// asymmetry is why the Supabase backend is still marked experimental.
//
// IMPORTANT: this file is additive. No existing route or service
// imports from here yet. When we're ready to cut over, we'll swap the
// caseBuilder imports in index.ts over to these functions — one route
// at a time, behind the same feature flag.
// ─────────────────────────────────────────────────────────────────────

import * as caseBuilder from "../services/caseBuilder";
import type { OffenderProfile } from "../services/caseBuilder";
import * as supa from "./supabaseClient";

type Backend = "json" | "supabase";

function currentBackend(): Backend {
  const raw = (process.env.CASES_BACKEND ?? "json").toLowerCase().trim();
  if (raw === "supabase") {
    if (!supa.isSupabaseConfigured()) {
      console.warn(
        "[CasesAdapter] CASES_BACKEND=supabase but Supabase is not configured. " +
        "Falling back to json. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY."
      );
      return "json";
    }
    return "supabase";
  }
  return "json";
}

/**
 * List offenders visible to the given user.
 *
 * In json mode, userId is used to filter the shared cases.json by
 * subscriberIds[] (matching caseBuilder's existing semantics). Pass
 * undefined to get everything — equivalent to the current getAllOffenders().
 *
 * In supabase mode, userId is REQUIRED — passing undefined returns an
 * empty array, because returning another user's data on a buggy call
 * would be a privacy bug.
 */
export async function listOffenders(userId?: string): Promise<OffenderProfile[]> {
  if (currentBackend() === "supabase") {
    if (!userId) {
      console.warn(
        "[CasesAdapter] listOffenders called without userId in supabase mode. " +
        "Refusing to return cross-tenant data."
      );
      return [];
    }
    return supa.listOffendersForUser(userId);
  }

  // json mode
  const all = caseBuilder.getAllOffenders();
  if (!userId) return all;
  return all.filter((o) => o.subscriberIds.includes(userId));
}

/**
 * Fetch a single offender by normalized phone number, scoped to the user.
 */
export async function getOffender(
  userId: string | undefined,
  normalizedNumber: string
): Promise<OffenderProfile | null> {
  if (currentBackend() === "supabase") {
    if (!userId) {
      console.warn(
        "[CasesAdapter] getOffender called without userId in supabase mode."
      );
      return null;
    }
    return supa.getOffenderForUser(userId, normalizedNumber);
  }

  // json mode — caseBuilder.getOffender is not user-scoped; filter post-hoc.
  const profile = caseBuilder.getOffender(normalizedNumber);
  if (!profile) return null;
  if (userId && !profile.subscriberIds.includes(userId)) return null;
  return profile;
}

/**
 * Actionable (filable) offenders for a user — the "Ready to file" list.
 * Excludes already-filed offenders.
 */
export async function listActionable(userId?: string): Promise<OffenderProfile[]> {
  if (currentBackend() === "supabase") {
    if (!userId) {
      console.warn(
        "[CasesAdapter] listActionable called without userId in supabase mode."
      );
      return [];
    }
    return supa.listActionableOffendersForUser(userId);
  }

  return caseBuilder.getActionableCases(userId);
}

/** Introspection: which backend is active right now? Useful for /api/health. */
export function activeBackend(): Backend {
  return currentBackend();
}
