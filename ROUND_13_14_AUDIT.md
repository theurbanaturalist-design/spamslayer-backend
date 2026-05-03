# Round 13 — Hostile Legal Review (Defense/Judge POV)

## 🔴 CRITICAL LEGAL ATTACK VECTORS

### ATTACK 1: Perjury trap in verification (`legalFilingGenerator.ts:1201-1209`)
Plaintiff swears under penalty of perjury that **"I have personally reviewed each recording and transcript"** and (in Recording Authentication Declaration, `1409-1413`) that **"I have personally listened to each recording after capture"**. If the user hasn't literally listened to every recording, they commit perjury by signing this. The filing generator produces this statement unconditionally.
**Fix**: Change to "I have had an opportunity to review each recording and have personally reviewed representative samples" OR gate this behind a filing checkbox.

### ATTACK 2: "Agent" conclusion is a legal opinion, not a fact
Verification: "I authorized my telephone compliance system (SpamSlayer) to answer and record calls on my behalf as my agent." Agency is a legal conclusion the court decides — plaintiff verifying it looks like legal argument, not personal knowledge.
**Fix**: State the FACT (I installed and configured the system to answer calls) and let the petition body argue agency separately.

### ATTACK 3: Mixed-use line / residential-subscriber wobble
Petition repeatedly asserts "residential telephone subscriber." User profile says Marcus uses the number for horticulture business. FCC (In re Rules, 2003) treats mixed-use where "primarily residential" as residential, but nothing in the petition confronts this head-on. Defense will subpoena carrier billing and expose the gap.
**Fix**: Add a "mixed-use" anticipatory paragraph citing 68 Fed. Reg. 44144, 44177 (2003) and the FCC's "primarily personal/residential use" standard.

### ATTACK 4: Honeypot optics in `phone.json` description
`"description": "TCPA compliance investigator — answers spam calls, extracts company info, records everything, builds legal cases automatically"` — this is Exhibit A for a Stoops/Nomorobo attack. If the defendant subpoenas the config (federal removal + discovery), it reads like a litigation factory.
**Fix**: (a) Warn the user this may be discoverable; (b) soften the internal description.

### ATTACK 5: 2024 FCC one-to-one consent rule vacatur not addressed
Insurance Marketing Coalition Ltd. v. FCC, 127 F.4th 303 (11th Cir. 2025) vacated the FCC's 1:1 consent rule. Consent defenses are more flexible post-vacatur. Filing guide doesn't cover it.
**Fix**: Add a reference + defense response.

### ATTACK 6: "Professional plaintiff" honeypot response is vulnerable
Stoops distinguishing rests on "I use it for real communication every day" — but the factual anchor is not in the petition, so the defense can impeach during cross. We already noted this in PROJECT_STATUS.
**Fix**: Add an optional "factual-use anchors" block the user can fill in.

### ATTACK 7: Verification of DNC registration date unsupported
"I registered my number on the National Do Not Call Registry" — the petition uses config's `dncRegistrationDate` ("2007" in phone.json) as a gospel fact, but plaintiff may not have documentary proof of the exact date. If the date is wrong by even a month, the verification is false.
**Fix**: Verification should say "registered my number on or about [year]" and require the user to confirm.

### ATTACK 8: La. R.S. 13:5211 appeal-waiver statement is dangerous for plaintiff
The filing guide says "parties waive the right to appeal from a small claims judgment" — but this cuts BOTH ways. If plaintiff LOSES (debt collection exemption, consent produced, etc.), they can't appeal. We note the transfer procedure but the tone understates plaintiff risk.
**Fix**: Strengthen the "if you lose" warning.

### ATTACK 9: SOL check doesn't block filing — only warns
`checkStatuteOfLimitations` returns a warning string if ANY calls are barred, but the filing is still generated. If the 2-year minority rule applies in Louisiana, a 3-year-old filing has all calls time-barred with zero warning.
**Fix**: Add explicit 2-year warning and consider blocking filings where ALL calls are beyond 2 years.

### ATTACK 10: Verification's "I received each call at issue on my telephone line" is OK but not bulletproof
Defense argues: you DIDN'T receive it — a bot did. The petition has rebuttal language but the verification statement alone could be cross-examined.
**Fix**: Strengthen to "Each call was placed to my telephone line and was captured by the compliance system operating on my line, as received at my number."

---

## 🟡 CODE DEPENDABILITY BUGS (Round 14)

### BUG 1: `evidenceIntegrity.ts:220-232` — self-referential integrity check
```ts
const recomputed = crypto.createHash("sha256")
  .update(sig.sha256Hash + sig.metadataHash)
  .digest("hex");
if (recomputed !== sig.combinedHash) { /* tamper detected */ }
```
This verifies that `combinedHash = sha256(sha256Hash + metadataHash)` — but it **never** recomputes `metadataHash` from the actual `sig.metadata` object. Attacker can edit `sig.metadata.callDate` without touching the hash fields and integrity check passes.
**Fix**: Recompute `metadataHash` from `sig.metadata` and compare.

### BUG 2: `evidenceIntegrity.ts:56` — `process.cwd()` for storage path
If cwd changes (cron, different entrypoint), signatures scatter across filesystem. Legal evidence must live at a deterministic path.
**Fix**: Anchor to `__dirname`.

### BUG 3: `evidenceIntegrity.ts:133, 198` — no file permissions on signature files
SHA-256 files contain phone numbers + call metadata (PII). Written with default umask.
**Fix**: `mode: 0o600`, `fs.chmodSync` post-write.

### BUG 4: `evidenceIntegrity.ts:133` — signEvidence silently overwrites
If the same callSid is signed twice, the first signature disappears. Should warn or append.
**Fix**: Check existence, warn and archive previous.

### BUG 5: `caseBuilder.ts:63` — `writeQueue` declared but never used
Comment promises write serialization. Reality: parallel `logCall` calls race → last-writer-wins data loss.
**Fix**: Wrap `saveCases` in the queue.

### BUG 6: `caseBuilder.ts:107, 420` — cases.json has no restrictive permissions
PII database at rest without mode 0o600.
**Fix**: Set mode on write.

### BUG 7: `caseBuilder.ts:159` — `isWithin12Months` uses `setUTCFullYear(+1)` but filing generator uses `setUTCMonth(+12)`. Edge dates can diverge.
**Fix**: Unify on one algorithm (filing generator is authoritative).

### BUG 8: No "case filed" state — offender can still be mutated after filing
PROJECT_STATUS item #3. If a new call arrives after filing, `damagesEstimate` changes silently and no longer matches the petition.
**Fix**: Add `filedAt: string | null` and reject `logCall` mutation once set (or snapshot).

### BUG 9: `evidenceIntegrity.ts:106-114` — metadata stringify is non-deterministic
Re-serializing with different key order produces a different hash. JSON.stringify follows insertion order which is *usually* stable in V8 but not guaranteed.
**Fix**: Sort keys for hashing.

### BUG 10: `legalFilingGenerator.ts:31` — `process.cwd()` for phone.json path
Same cwd-brittleness as Bug 2. If server is run from a different directory, config is silently missing.
**Fix**: Anchor to module location; pre-flight existence check.

---

## 📊 10 ADVERSARIAL PRACTICE TRIALS

### TRIAL 1: Defense produces TOS with plaintiff's name from lead broker
- Filing generator WARNS about this in the guide but doesn't block.
- Plaintiff has no defense if consent is produced.
- **RESULT**: Plaintiff can lose. No code fix — user awareness issue. Warning adequate.

### TRIAL 2: Defense subpoenas SpamSlayer config, exposes "builds legal cases automatically" description
- Looks like honeypot. Stoops/Nomorobo attack lands.
- **RESULT**: FAIL. Fix phone.json description to neutral language.

### TRIAL 3: Defense calls plaintiff to stand: "Have you personally listened to every recording?"
- Plaintiff says no → verification is perjury.
- Plaintiff says yes → lie, impeachable if other evidence shows otherwise.
- **RESULT**: FAIL. Fix verification language.

### TRIAL 4: Defense files 2-year SOL defense under minority rule
- Filing generator assumes 4-year SOL. If Louisiana court adopts 2-year state SOL, case fails.
- **RESULT**: PARTIAL PASS. SOL section already warns about 2-year rule in filing guide. But filing isn't blocked. Add 2-year defensive motion script.

### TRIAL 5: Defense removes to federal court
- Guide has remand script. But 2026 trends (McLaughlin vs. McKesson) make federal less scary.
- **RESULT**: PASS. Existing coverage adequate.

### TRIAL 6: Defense produces "safe harbor" compliance logs and rings through 1 mistaken call
- If defendant can show 31-day scrubbed DNC, safe harbor may apply.
- Petition forces defendant to produce proof. Plaintiff needs ≥2 calls to survive.
- **RESULT**: PASS. Petition structure handles this.

### TRIAL 7: Defense subpoenas Twilio; Twilio can't produce recording (retention policy)
- Filing guide warns about 30-day retention; recommends USB backup.
- **RESULT**: PASS if user followed instructions. Add stronger warning.

### TRIAL 8: Defense attacks "agent" legal conclusion in verification
- Plaintiff verified a legal conclusion, not a fact. Defense moves to strike.
- **RESULT**: FAIL. Fix verification to state facts only.

### TRIAL 9: Defense produces billing records showing business use
- Mixed-use challenge. Petition weakly asserts residential only.
- **RESULT**: FAIL. Add mixed-use anticipatory paragraph.

### TRIAL 10: Defense challenges integrity certificate authenticity
- "Who computed the hash? Plaintiff's own system. How do I know it wasn't tampered?"
- Current check is self-referential (Bug 1). Defense expert tears it apart.
- **RESULT**: FAIL. Fix metadata hash verification.

---

## SUMMARY

- **10 trials run**
- **6 FAIL** (attacks 2, 3, 8, 9, 10, plus partial 4)
- **4 PASS**
- All 6 failures have code fixes identified. Applying inline.
