# Round 15 Audit — Hostile Review After Frontend Build

Date: 2026-04-17
Scope: Full re-read of legal text, new API surface, frontend wiring, race
conditions, and auth posture after the frontend + Settings/Help pages
landed.

Findings ordered by severity. Severity key:

- **BLOCKER** — do not ship / do not file
- **HIGH** — fix before anyone files a real case
- **MEDIUM** — fix before the next release
- **LOW** — follow-up polish
- **NIT** — documentation / cleanup

---

## BLOCKERS

### B1. Perjury trap in petition paragraph — "All calls were recorded"

`backend/src/services/legalFilingGenerator.ts:942-957`

The conditional predicate is `offender.calls.some((c) => c.recordingUrl)`
(any one call has a recording), but the resulting paragraph declares:

> "All calls were recorded under [state recording law]... Full recordings,
> metadata, cryptographic integrity hashes, and transcripts are preserved
> and attached as exhibits."

If only 1 of N calls has a recording (common — Twilio recording can fail,
get truncated, or be disabled mid-call), this paragraph is **literally
false** and the plaintiff swears to it under the verification at
line 1255. This is a straightforward perjury risk.

**Fix:** Either (a) gate the paragraph on `.every(c => c.recordingUrl)`
and use different language when only some calls were recorded, or
(b) rewrite the paragraph to quantify: "N of M calls were recorded; the
remainder are documented via call detail records and transcripts from
the Twilio platform." I recommend (b) — it's truthful in every case and
still supports admissibility.

### B2. Wrong statutory subsection for Count II

`backend/src/services/legalFilingGenerator.ts:770-771, 1149-1178`

The code comment and petition text both assert that **§ 227(b)(1)(B)**
covers cellular telephone numbers. This is backwards:

- **§ 227(b)(1)(A)(iii)** covers ATDS / artificial or prerecorded voice
  calls to cellular service.
- **§ 227(b)(1)(B)** covers calls using an artificial or prerecorded
  voice to a *residential* telephone line.

The rest of the petition *establishes that the plaintiff is a residential
subscriber* (see paragraphs I, III, and the verification). Count II then
invokes § 227(b)(1)(B) and describes it as a cellular-number provision.
A defense motion to dismiss Count II on "you've pled the wrong subsection"
grounds is not hypothetical — it's an afternoon of work for any lawyer.

**Fix:** If the line is residential, Count II should cite § 227(b)(1)(B)
and correctly describe the *residential* prohibition (artificial /
prerecorded voice without prior express consent). If any SpamSlayer
user might actually be using a cell line, add a `lineType`
(residential / cellular) setting in phone.json and select the correct
subsection based on that. Do not guess — citing the wrong statute is
the single easiest way for a defendant to get a count stricken.

### B3. Unauthenticated config read/write + wide-open CORS

`backend/src/index.ts:39, 190-222`

`app.use(cors())` allows every origin, and `/api/config` has no auth
guard. In the current localhost-dev deployment this is survivable, but:

- Any browser tab the user opens can POST to `http://localhost:3003/api/config`
  and overwrite the full filing configuration. A malicious ad on any site
  could set `damagesWillful: 0`, corrupt the `filingConfig`, or set
  `userName: "Mickey Mouse"` on the next generated petition.
- The read endpoint leaks `userName`, `userAddress`, `userPhone`,
  `userEmail`, and `dncRegistrationDate` to any origin — a targeted PII
  exfiltration vector from cross-site JS.
- Same issue on `/api/cases/filing/:number/save` — a drive-by POST
  triggers a disk write and permanently marks a case as filed.

**Fix path (minimum):**
1. Restrict CORS to `http://localhost:5173` (Vite dev) and whatever the
   production origin will be. Drop `app.use(cors())`.
2. Add an origin/host check middleware on write endpoints
   (`POST /api/config`, `POST /api/cases/filing/*/save`,
   `POST /api/cases/demand-letter`).
3. Longer term: generate a one-time dev token on first backend start,
   require it as a header on write endpoints. Twilio webhook routes
   already do signature validation — apply a parallel pattern here.

### B4. POST /api/config accepts any JSON shape

`backend/src/index.ts:205-222`

The code accepts `req.body` as long as it's an object, stringifies it,
and writes it to `phone.json`. That means:

- Missing required keys **silently vanish**. If the client sends only
  `filingConfig`, the `caseThreshold`, `damagesPerViolation`, etc. are
  wiped. Next filing generated uses `undefined` where a dollar figure
  was expected.
- Unknown keys are preserved verbatim — an attacker (via B3) can plant
  arbitrary payload in the config file.
- Type coercion isn't checked. A client could set
  `caseThreshold: "lots"` and the generator would crash on a numeric
  comparison the next time a call lands.

The config drives a sworn legal document. This is unacceptable.

**Fix:** Validate against an explicit schema (Zod or a hand-rolled
type-guard): required keys, expected types, no unknown keys, numeric
fields are finite positive numbers, string fields are non-empty where
required. Reject with 400 on any violation.

---

## HIGH

### H1. Filing save is not atomic with case state

`backend/src/services/legalFilingGenerator.ts:2653-2770`

The save flow is:

1. `generateFilingPackage(normalized)` — reads offender (no lock)
2. Writes 5 files to disk over ~20–200ms
3. `markOffenderFiled(normalized, caseRef)` — locks profile

Between steps 1 and 3, an incoming Twilio webhook running
`caseBuilder.logCall()` appends a new call to the **same** profile
(because `filedAt` is still null). The filing on disk cites N calls and
$N×500; the live DB now says N+1 calls and $(N+1)×500. Dashboard shows
one number, petition says another.

Underclaiming is mostly harmless (you can't recover more than you
prayed for), but:
- UX confusion on the Dashboard vs. the saved petition.
- If the call landed just before the "12-month sliding window" check,
  the validator's snapshot of whether the case is actionable could
  differ from the on-disk assertion.

**Fix:** Snapshot the profile and mark filed **atomically** first,
then generate + write from the snapshot:

```ts
const snapshot = mutateCasesSync((db) => {
  const p = db[normalized];
  if (!p) return null;
  if (p.filedAt) return null; // already filed — caller decides
  p.filedAt = new Date().toISOString();
  p.filedCaseRef = /* needs generateCaseRef moved up */;
  return structuredClone(p);
});
if (!snapshot) return null;
// now generate/write using snapshot — any new logCall lands on
// `${key}#post-filed` continuation profile
```

### H2. Concurrent POST /save creates duplicate filings

Same file, same flow. If the user double-clicks the save button
(or network retries), two requests arrive ~ms apart:

- Both generate filing packages with different `caseRef` (random hex
  suffix — good, no directory collision)
- Both write 5 files each to disk (= 10 files across 2 directories)
- First `markOffenderFiled` succeeds; second sees `filedAt` set and
  logs a warning, but the second directory is orphaned PII on disk.

The frontend's `saveState === "saving"` check helps but doesn't prevent
retry-on-network-error or rapid-fire curl.

**Fix:** Per-offender in-flight lock in `LegalFiling.generateAndSaveFilingPackage`,
or check `offender.filedAt` at the top of the function and short-circuit
with an error if already filed. Combined with H1's atomic approach, this
comes for free.

### H3. Absolute "Plaintiff has never" consent paragraph

`backend/src/services/legalFilingGenerator.ts:1043-1049`

Sworn text states, without qualification:

> "Plaintiff has never: (a) completed any form, application, or
> agreement with Defendant; (b) inquired about Defendant's products
> or services; (c) provided Plaintiff's telephone number to Defendant
> or authorized any third party to share it with Defendant; or (d)
> taken any action that could reasonably be construed as inviting
> contact from Defendant."

The data-broker industry's whole business model is **buried consent via
clicked TOS** on unrelated sites. If the defendant produces a 2019 TOS
agreement with the plaintiff's phone and a consent-to-contact clause,
this paragraph becomes demonstrably false — and the plaintiff swore to
it.

The generator already emits a runtime **warning** about buried consent
(correct) but the petition itself still makes absolute claims.

**Fix:** Soften to "Plaintiff has not knowingly..." / "Plaintiff has no
record of having..." throughout (a)-(d). Also shift the "burden on
defendant" language (which is accurate) to carry more of the work.

### H4. "Primary use" residential claim is unverifiable by the user

`backend/src/services/legalFilingGenerator.ts:924-940`

The petition asserts the line is "used primarily for residential and
personal purposes" and cites the 2003 Federal Register primary-use
test. This is correct legal doctrine, but the *generator assumes it
without asking the user*. If the user runs a small business out of
their home phone (a legitimate use case given the project persona —
"helping the horticulture industry and other small business
applications"), this paragraph may be false, and an active defendant
could depose the plaintiff into contradicting it.

**Fix:** Add a Settings question: "Is this line used primarily for
personal/residential purposes, with at most incidental business use?"
(yes/no/unsure). If not "yes", refuse to generate a filing that
includes the residential-status paragraph. If "unsure", emit a
STRONG warning and link to guidance.

---

## MEDIUM

### M1. Dashboard double-renders filed offenders as continuation profiles

`backend/src/services/caseBuilder.ts:325-352` (continuation routing)
`backend/src/services/caseBuilder.ts:521-524` (`getAllOffenders`)
`frontend/src/lib/format.ts:25-35` (`formatPhone`)

`logCall` routes post-filing calls to a profile keyed
`${normalizedNumber}#post-filed`. `getAllOffenders` returns *all*
profiles, so the Dashboard shows two entries for the same phone:
one "Filed", one "Watching" with the same formatted number (because
`formatPhone` strips the `#` suffix when generating digits).

Clicking the continuation profile navigates to
`/cases/+15551234567%23post-filed`; the backend's `normalizePhone`
strips the `#` and returns the *original* filed profile. So the user
clicks on a watching row and lands on a filed case. Confusing.

**Fix options:**
1. `getAllOffenders` filters out keys containing `#` by default, with
   an `includeContinuations: true` option.
2. Merge continuations into parent in the API response, exposing
   `postFilingCalls: CallEntry[]` on the parent profile.
3. (Minimum) Dashboard filters `offender.normalizedNumber.includes("#")`
   for now, with a TODO.

### M2. Stale-comment lie about continuation profiles

`backend/src/services/caseBuilder.ts:56`

```
// post-filing continuation (not yet implemented — see PROJECT_STATUS).
filedAt?: string | null;
```

The feature IS implemented (at line 325+). The comment is a trap for
future readers — they'll try to re-implement it and introduce conflicts.

**Fix:** Delete the "not yet implemented" clause.

### M3. Filings directory resolution uses `process.cwd()`

`backend/src/services/legalFilingGenerator.ts:2661`

```
const baseDir = path.resolve(process.cwd(), "filings");
```

Same class of bug we previously fixed for `PHONE_CONFIG_PATH`. If the
backend is started from any directory other than `backend/`, the
filings land in a surprise location. `npm run dev` happens to start
from the package dir so this is latent — but it will bite in prod
deployment.

**Fix:** `path.resolve(__dirname, "..", "..", "filings")` (one level
up from compiled dist, one level up from src in dev), or accept an
explicit `FILINGS_DIR` env var.

### M4. Directory creation happens before path-traversal check

`backend/src/services/legalFilingGenerator.ts:2679-2689`

```
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// ...then...
const realDir = fs.realpathSync(dir);
const realBase = fs.realpathSync(baseDir);
if (!realDir.startsWith(realBase)) { throw ... }
```

`mkdirSync` with `recursive: true` will follow `..` segments and
create directories outside `baseDir` *before* the realpath check
fires. In practice `caseRef` is deterministic (`SS-YYYYMMDD-nnnn-hex`)
and can't contain `..`, so this is theoretical — but the `outputDir`
parameter accepts arbitrary strings from callers.

**Fix:** Normalize and validate `outputDir` *before* any `mkdirSync`
call.

### M5. Damages rounding and small-claims cap display inconsistency

`backend/src/services/legalFilingGenerator.ts:1193-1219`

When `wasCapped` is true, the PRAYER (line 1232) uses
`cappedDamages.toLocaleString()`, but the Damages section narrative
repeats `config.smallClaimsLimit` as a display string. If the user
typed the cap as `"$5,000"` and the integer parse gives `5000`, both
display correctly. If they typed `"5000"` (no `$`), the narrative
shows "5000" where the prayer shows "$5,000" — a minor inconsistency
that looks sloppy in court.

**Fix:** Normalize `smallClaimsLimit` to a canonical display form
(`formatCurrency(limitNum)`) in one place and reuse.

---

## LOW

### L1. JargonTip closes on button blur — prevents text selection

`frontend/src/components/JargonTip.tsx:20`

```
onBlur={() => setOpen(false)}
```

Clicking inside the tooltip to select a definition closes it
immediately. For a tooltip whose whole purpose is reading text,
this is user-hostile.

**Fix:** Close on document-level click-outside via `useRef` +
`useEffect`, not button blur. Also add `aria-controls` on the button
pointing to a tooltip `id` so screen readers understand the
relationship.

### L2. Hardcoded date in Layout footer

`frontend/src/components/Layout.tsx:49`

> "Generated documents are based on public statutes and case law
> current as of April 2026."

Will go stale. This is acceptable for now (laws *did* freeze at that
date for this review cycle), but create a `LEGAL_REVIEW_DATE` constant
in one place so future you only updates it once.

### L3. ErrorPanel leaks backend `err.message` strings

`backend/src/index.ts:142, 163, 179, 201, 220`
`frontend/src/components/LoadError.tsx:15-32`

`500` handlers return `detail: err?.message` and the frontend renders
it in the error panel. Acceptable on localhost; would need scrubbing
before any public deployment.

### L4. Emoji severity indicators in Alert component

`frontend/src/components/Alert.tsx:24`

For a tool that generates **sworn court documents**, emoji severity
markers (⛔⚠️✅ℹ️) undermine the gravity of the UX. They're also
inconsistent with the textual severity labels that do the real work.
Consider swapping for inline SVG glyphs matching the rest of the
shield-iconography design language.

### L5. FilingPreview `download` uses `document.createElement("a")`

`frontend/src/pages/FilingPreview.tsx:70-79`

Works, but leaks a DOM node per download (not appended to body — the
click fires, blob URL is revoked, node is GC'd). Safer pattern is to
skip creating the anchor and use `window.location.href = url` with
Content-Disposition, but that requires backend support. Current
approach is fine; noting for future.

---

## NITS

### N1. `useEffect` dep-list eslint-disable

All three page files do:

```ts
useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [number]);
```

This is correct (`load` is defined per-render but closes over
`number`), but the comment suppressing the warning invites future
devs to copy-paste the pattern where it's wrong. Prefer `useCallback`
or move `load` outside the component.

### N2. README mentions baseline errors without linking to tracker

Status line: "9 pre-existing type errors... tracked and will be swept
in a future pass." No ticket / issue number. If those errors ever
matter they'll be hard to find.

### N3. No `.gitignore` entry audit performed

Did not verify `filings/`, `cases.json`, and `phone.json` are
gitignored. Sensitive PII in the repo would be very bad.

---

## Summary scoreboard

| Severity  | Count | New in Round 15 |
|-----------|-------|-----------------|
| BLOCKER   | 4     | B1, B2, B3, B4  |
| HIGH      | 4     | H1, H2, H3, H4  |
| MEDIUM    | 5     | M1, M2, M3, M4, M5 |
| LOW       | 5     | L1, L2, L3, L4, L5 |
| NIT       | 3     | N1, N2, N3      |

The four blockers (two legal perjury traps, two security/auth) are
the material ones. Round 13/14 fixed the earlier perjury traps but
B1 and B2 slipped through — B1 because the predicate-vs-prose
mismatch is easy to miss in a 2,770-line file, and B2 because the
wrong statutory subsection was carried forward from an original
template. Neither would be caught by the existing smoke tests.

Recommended next action: fix B1 + B2 inline today (30 minutes of
work), then B3 + B4 before anyone outside localhost touches this
service.
