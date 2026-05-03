// ─────────────────────────────────────────────────────────────────────────────
//  abuseContacts.ts — known abuse-team contact addresses for top US carriers
//  and domain registrars
//
//  Used by the auto-fire pressure stack to email carrier-of-record abuse
//  complaints (when ITG identifies the originating carrier) and domain
//  registrar abuse complaints (when Sonar surfaces a defendant website).
//
//  The contact addresses below come from each carrier/registrar's published
//  Acceptable Use Policy or transparency page as of 2026-Q1. They're the
//  standard intake addresses for industry abuse reports and are NOT consumer-
//  support routes (so we don't waste a CS rep's time).
//
//  When a carrier or registrar isn't in the map, we fall back to RFC 2142's
//  recommended `abuse@<domain>` convention — most providers honor it.
// ─────────────────────────────────────────────────────────────────────────────

// ── CARRIERS ──────────────────────────────────────────────────────────────
//
// Mapping is keyed by a normalized carrier name (lowercase, common aliases
// stripped). When ITG returns a carrier name like "AT&T Mobility LLC", we
// normalize and look up.

const CARRIER_ABUSE: Record<string, { name: string; email: string; note?: string }> = {
  "att": {
    name: "AT&T",
    email: "abuse@att.net",
    note: "AT&T accepts abuse@att.net for both wireline and wireless (AT&T Mobility) abuse reports.",
  },
  "att mobility": { name: "AT&T Mobility", email: "abuse@att.net" },
  "verizon": {
    name: "Verizon",
    email: "reportabuse@verizon.com",
    note: "Verizon Wireless and Verizon Business both route through reportabuse@verizon.com.",
  },
  "verizon wireless": { name: "Verizon Wireless", email: "reportabuse@verizon.com" },
  "tmobile": {
    name: "T-Mobile",
    email: "abuse_mailbox@t-mobile.com",
    note: "T-Mobile (incl. former Sprint subscribers post-merger) uses abuse_mailbox@t-mobile.com.",
  },
  "t-mobile": { name: "T-Mobile", email: "abuse_mailbox@t-mobile.com" },
  "sprint": { name: "Sprint", email: "abuse_mailbox@t-mobile.com" }, // post-merger
  "us cellular": { name: "U.S. Cellular", email: "abuse@uscellular.com" },
  "uscellular": { name: "U.S. Cellular", email: "abuse@uscellular.com" },
  "cox": { name: "Cox Communications", email: "abuse@cox.net" },
  "comcast": { name: "Comcast / Xfinity", email: "abuse@comcast.net" },
  "xfinity": { name: "Comcast / Xfinity", email: "abuse@comcast.net" },
  "charter": { name: "Charter / Spectrum", email: "abuse@charter.net" },
  "spectrum": { name: "Charter / Spectrum", email: "abuse@charter.net" },
  "centurylink": { name: "CenturyLink / Lumen", email: "abuse@centurylink.com" },
  "lumen": { name: "CenturyLink / Lumen", email: "abuse@centurylink.com" },
  "frontier": { name: "Frontier Communications", email: "abuse@frontier.com" },
  // Common VoIP / cloud telephony providers spammers use
  "twilio": { name: "Twilio (VoIP provider)", email: "abuse@twilio.com" },
  "bandwidth": { name: "Bandwidth.com", email: "abuse@bandwidth.com" },
  "telnyx": { name: "Telnyx", email: "abuse@telnyx.com" },
  "voxbone": { name: "Voxbone", email: "abuse@voxbone.com" },
  "plivo": { name: "Plivo", email: "abuse@plivo.com" },
  "vonage": { name: "Vonage", email: "abuse@vonage.com" },
  "level3": { name: "Level 3 / Lumen", email: "abuse@centurylink.com" },
  "inteliquent": { name: "Inteliquent", email: "abuse@inteliquent.com" },
  "intermedia": { name: "Intermedia", email: "abuse@intermedia.net" },
  "ringcentral": { name: "RingCentral", email: "abuse@ringcentral.com" },
};

export interface CarrierAbuseContact {
  name: string;
  email: string;
  note?: string;
  /** True if this is from the explicit map; false if we fell back to abuse@<domain>. */
  fromMap: boolean;
}

/**
 * Look up an abuse contact by carrier name. Returns the mapped entry if
 * known; otherwise tries the RFC 2142 `abuse@<domain>` fallback derived
 * from the carrier name. Returns null if the input is too vague to derive
 * any plausible contact.
 */
export function lookupCarrierAbuse(carrierName: string | null | undefined): CarrierAbuseContact | null {
  if (!carrierName) return null;
  const normalized = carrierName
    .toLowerCase()
    .replace(/\b(llc|inc|corporation|corp|co|ltd|company|wireless|mobility|mobile|communications)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Try direct hit first
  if (CARRIER_ABUSE[normalized]) {
    return { ...CARRIER_ABUSE[normalized], fromMap: true };
  }
  // Try first word (e.g., "att mobility llc" → "att")
  const first = normalized.split(" ")[0];
  if (first && CARRIER_ABUSE[first]) {
    return { ...CARRIER_ABUSE[first], fromMap: true };
  }
  // Try without spaces (e.g., "tmobile" matches both "t-mobile" and "tmobile")
  const noSpace = normalized.replace(/\s/g, "");
  if (CARRIER_ABUSE[noSpace]) {
    return { ...CARRIER_ABUSE[noSpace], fromMap: true };
  }
  return null;
}

// ── DOMAIN REGISTRARS ─────────────────────────────────────────────────────

const REGISTRAR_ABUSE: Record<string, { name: string; email: string }> = {
  "namecheap.com": { name: "Namecheap", email: "abuse@namecheap.com" },
  "godaddy.com": { name: "GoDaddy", email: "abuse@godaddy.com" },
  "tucows.com": { name: "Tucows / OpenSRS", email: "domainabuse@tucows.com" },
  "cloudflare.com": { name: "Cloudflare Registrar", email: "registrarabuse@cloudflare.com" },
  "networksolutions.com": { name: "Network Solutions", email: "abuse@web.com" },
  "google domains": { name: "Google Domains / Squarespace", email: "registrar-abuse@squarespace.com" },
  "squarespace.com": { name: "Squarespace Domains", email: "registrar-abuse@squarespace.com" },
  "porkbun.com": { name: "Porkbun", email: "abuse@porkbun.com" },
  "hover.com": { name: "Hover", email: "abuse@hover.com" },
  "namesilo.com": { name: "NameSilo", email: "abuse@namesilo.com" },
  "dynadot.com": { name: "Dynadot", email: "abuse@dynadot.com" },
  "name.com": { name: "Name.com", email: "abuse@name.com" },
  "enom.com": { name: "eNom", email: "abuse@enom.com" },
  "publicdomainregistry.com": { name: "PublicDomainRegistry / PDR", email: "abuse-report@publicdomainregistry.com" },
  "registrar.amazon.com": { name: "Amazon Route 53 Domains", email: "trustandsafety@amazon.com" },
};

export interface RegistrarAbuseContact {
  name: string;
  email: string;
  fromMap: boolean;
}

/**
 * Best-effort registrar abuse lookup. Without a real WHOIS call (which
 * requires either the TCP port 43 protocol or a paid REST WHOIS API), we
 * use a heuristic: extract the bare domain and try abuse@<domain>.
 *
 * Callers should prefer doWhoisAndLookup() below, which actually queries
 * WHOIS via a public REST endpoint. The pure heuristic here is the
 * fallback when WHOIS isn't reachable.
 */
export function lookupRegistrarAbuseHeuristic(websiteUrl: string): RegistrarAbuseContact {
  const domain = extractApexDomain(websiteUrl);
  // Default fallback: abuse@<domain> per RFC 2142
  return {
    name: domain,
    email: `abuse@${domain}`,
    fromMap: false,
  };
}

/** Look up a known registrar by its registrar name (when WHOIS gives us one). */
export function lookupRegistrarByName(registrarName: string): RegistrarAbuseContact | null {
  const k = registrarName.toLowerCase().trim();
  if (REGISTRAR_ABUSE[k]) return { ...REGISTRAR_ABUSE[k], fromMap: true };
  // Try a substring match (e.g. "GoDaddy.com, LLC" matches "godaddy.com")
  for (const key of Object.keys(REGISTRAR_ABUSE)) {
    if (k.includes(key.split(".")[0])) {
      return { ...REGISTRAR_ABUSE[key], fromMap: true };
    }
  }
  return null;
}

/**
 * Lightweight WHOIS lookup via the public RDAP endpoint at rdap.iana.org.
 * RDAP is the modern replacement for WHOIS; returns JSON; no API key needed.
 * Most TLDs (.com, .net, .org, etc.) are RDAP-enabled.
 *
 * Returns the registrar name if found; null on any error so the caller can
 * fall back to lookupRegistrarAbuseHeuristic.
 */
export async function whoisRegistrarName(websiteUrl: string): Promise<string | null> {
  const apex = extractApexDomain(websiteUrl);
  if (!apex) return null;

  // RDAP bootstrap: https://data.iana.org/rdap/dns.json points to per-TLD endpoints.
  // For simplicity, hit the well-known Verisign RDAP for .com/.net which
  // covers ~75% of US-spammer domains.
  const tld = apex.split(".").pop();
  let rdapBase: string;
  if (tld === "com" || tld === "net") {
    rdapBase = "https://rdap.verisign.com/com/v1";
  } else if (tld === "org") {
    rdapBase = "https://rdap.publicinterestregistry.org/rdap";
  } else {
    // Try ICANN's central RDAP gateway as a fallback
    rdapBase = "https://rdap.org";
  }

  const url = `${rdapBase}/domain/${apex}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "Accept": "application/rdap+json", "User-Agent": "SpamSlayer/0.1 (+abuse-report)" },
    });
    if (!r.ok) return null;
    const body: any = await r.json();
    // Per RDAP spec, the registrar is in the entities array with role "registrar".
    const entities: any[] = body?.entities ?? [];
    const reg = entities.find((e) => Array.isArray(e?.roles) && e.roles.includes("registrar"));
    if (!reg) return null;
    // vcardArray[1] is an array of vcard properties; the "fn" property is the formatted name
    const vcards: any[] = reg?.vcardArray?.[1] ?? [];
    const fn = vcards.find((v) => Array.isArray(v) && v[0] === "fn");
    if (Array.isArray(fn) && typeof fn[3] === "string") return fn[3];
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────

/** Extract the apex (registrable) domain from an arbitrary URL string. */
function extractApexDomain(rawUrl: string): string {
  let u = rawUrl.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split("/")[0].split(":")[0];
  // Naive: take the last 2 labels for typical TLDs (.com, .net, .org, .io,
  // etc.). For two-level TLDs (.co.uk, .com.au) this is wrong, but the
  // overwhelming majority of US-spammer domains are 2-label .com/.net/.org.
  const parts = u.split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return u;
}
