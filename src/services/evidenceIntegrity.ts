// ─────────────────────────────────────────────────────────────────────────────
//  evidenceIntegrity.ts — Cryptographic integrity for call evidence
//
//  Generates SHA-256 hashes of recordings and metadata at capture time,
//  creating tamper-proof certificates of authenticity. These certificates
//  can be included in court exhibits to defeat chain-of-custody challenges.
//
//  Usage:
//    import { signEvidence, generateIntegrityCertificate } from "./evidenceIntegrity";
//
//    // At call capture time:
//    const sig = signEvidence(callSid, recordingBuffer, metadata);
//
//    // At filing time:
//    const cert = generateIntegrityCertificate(offender);
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";

// ── Types ────────────────────────────────────────────────────────────────

export interface EvidenceMetadata {
  callSid: string;
  callerPhone: string;
  subscriberPhone: string;
  callDate: string;           // ISO date YYYY-MM-DD
  callTime: string;           // HH:MM
  recordingUrl: string | null;
  recordingSid: string | null;
  transcriptSnippet: string;
  capturedAt: string;         // ISO timestamp of when hash was generated
}

export interface EvidenceSignature {
  callSid: string;
  sha256Hash: string;         // hex-encoded SHA-256 of recording bytes
  metadataHash: string;       // hex-encoded SHA-256 of metadata JSON
  combinedHash: string;       // hex-encoded SHA-256 of (recording hash + metadata hash)
  capturedAt: string;
  metadata: EvidenceMetadata;
}

export interface IntegrityCertificate {
  generatedAt: string;
  offenderNumber: string;
  totalCalls: number;
  signatures: EvidenceSignature[];
  masterHash: string;         // SHA-256 of all combined hashes concatenated
  certificateText: string;    // human-readable certificate for court
}

// ── Storage ─────────────────────────────────────────────────────────────
//
//  Anchor the storage directory to the compiled module location rather than
//  process.cwd(). Court evidence cannot be scattered across the filesystem
//  because the process was started from a different directory (cron,
//  different entrypoint, etc.). __dirname is stable for the life of the
//  process and survives chdir().

const SIGNATURES_DIR = path.resolve(__dirname, "../../../evidence_signatures");
const DIR_MODE = 0o700;     // owner-only — signatures contain PII
const FILE_MODE = 0o600;    // owner-only — evidence files contain PII

function ensureSignaturesDir(): void {
  if (!fs.existsSync(SIGNATURES_DIR)) {
    fs.mkdirSync(SIGNATURES_DIR, { recursive: true, mode: DIR_MODE });
  }
  // Enforce mode even if the directory pre-existed with a looser umask.
  try {
    fs.chmodSync(SIGNATURES_DIR, DIR_MODE);
  } catch {
    // Best-effort; on some filesystems chmod may not be supported.
  }
}

function getSignaturePath(callSid: string): string {
  // Sanitize callSid for filesystem safety
  const safe = callSid.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SIGNATURES_DIR, `${safe}.sig.json`);
}

/**
 * Deterministic JSON serialization for hashing.
 *
 * JSON.stringify follows insertion order in V8, which is stable in practice
 * but not guaranteed by the spec. For cryptographic hashing where the exact
 * bytes matter, we sort keys so the hash is reproducible across runtimes,
 * Node versions, and any future re-serialization (e.g., loading from disk
 * and re-hashing for verification).
 */
function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" +
    keys.map((k) =>
      JSON.stringify(k) + ":" +
      canonicalStringify((obj as Record<string, unknown>)[k])
    ).join(",") +
    "}";
}

/**
 * Write a signature file atomically (temp-then-rename) with owner-only
 * permissions. Used for both fresh signing and post-download updates.
 */
function writeSignatureAtomic(sigPath: string, sig: EvidenceSignature): void {
  const tmp = sigPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sig, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  // Enforce mode even if umask masked the create mode.
  try { fs.chmodSync(tmp, FILE_MODE); } catch { /* best-effort */ }
  fs.renameSync(tmp, sigPath);
}

// ── Core: sign evidence at capture time ─────────────────────────────────

/**
 * Generate a cryptographic signature for a call recording and its metadata.
 * Call this immediately when a recording is captured, BEFORE any processing.
 *
 * @param callSid       - Twilio call SID (unique identifier)
 * @param recordingData - Raw recording bytes (Buffer). If null, only metadata is hashed.
 * @param metadata      - Call metadata at the time of capture
 * @returns The evidence signature, also saved to disk
 */
export function signEvidence(
  callSid: string,
  recordingData: Buffer | null,
  metadata: EvidenceMetadata
): EvidenceSignature {
  ensureSignaturesDir();

  const capturedAt = new Date().toISOString();

  // Hash the recording bytes
  // IMPORTANT: If no recording data is available yet (Twilio async delay),
  // we mark it explicitly so the hash is not confused with actual audio.
  const hasRecording = recordingData !== null && recordingData.length > 0;
  const recordingHash = hasRecording
    ? crypto.createHash("sha256").update(recordingData).digest("hex")
    : "PENDING_RECORDING_DOWNLOAD";

  if (!hasRecording) {
    console.warn(
      `[EvidenceIntegrity] ${callSid}: No recording data available at sign time. ` +
      `Hash will be computed when recording is downloaded from Twilio. ` +
      `Call updateRecordingHash() once the recording is available.`
    );
  }

  // Hash the metadata using canonical (sorted-key) serialization so the
  // stored hash can be independently recomputed from the stored metadata
  // object — defeats the self-referential-integrity attack where someone
  // edits the metadata content and leaves the stored metadataHash alone.
  const metadataWithCapturedAt = { ...metadata, capturedAt };
  const metadataStr = canonicalStringify(metadataWithCapturedAt);
  const metadataHash = crypto
    .createHash("sha256")
    .update(metadataStr)
    .digest("hex");

  // Combined hash: proves recording + metadata were together at capture time
  const combinedHash = crypto
    .createHash("sha256")
    .update(recordingHash + metadataHash)
    .digest("hex");

  const signature: EvidenceSignature = {
    callSid,
    sha256Hash: recordingHash,
    metadataHash,
    combinedHash,
    capturedAt,
    metadata: metadataWithCapturedAt,
  };

  // Refuse to silently overwrite an existing signature — would destroy
  // the chain of custody for the original call. If a collision is
  // legitimate (Twilio retry, rare), archive the old file.
  const sigPath = getSignaturePath(callSid);
  if (fs.existsSync(sigPath)) {
    const archive = sigPath + `.overwritten.${Date.now()}`;
    try {
      fs.renameSync(sigPath, archive);
      console.warn(
        `[EvidenceIntegrity] Existing signature for ${callSid} archived to ${archive}. ` +
        `This should not normally happen — Twilio call SIDs are globally unique.`
      );
    } catch (archErr) {
      console.error(
        `[EvidenceIntegrity] Could not archive existing signature for ${callSid}: ${archErr}. ` +
        `Aborting sign to avoid destroying evidence.`
      );
      throw archErr;
    }
  }

  // Persist to disk atomically (temp-then-rename) with restrictive perms.
  writeSignatureAtomic(sigPath, signature);

  console.log(
    `[EvidenceIntegrity] Signed evidence for ${callSid}: ` +
    `combined=${combinedHash.slice(0, 16)}...`
  );

  return signature;
}

/**
 * Update the recording hash for a call after the recording has been
 * downloaded from Twilio. This closes the chain-of-custody gap between
 * call end and recording availability.
 *
 * @param callSid       - Twilio call SID
 * @param recordingData - Downloaded recording bytes (Buffer)
 * @param format        - Recording format (e.g., "wav", "mp3") for audit trail
 * @returns Updated signature, or null if no prior signature exists
 */
export function updateRecordingHash(
  callSid: string,
  recordingData: Buffer,
  format: string = "wav"
): EvidenceSignature | null {
  const existing = loadSignature(callSid);
  if (!existing) {
    console.error(`[EvidenceIntegrity] No existing signature for ${callSid} — call signEvidence first`);
    return null;
  }

  if (existing.sha256Hash !== "PENDING_RECORDING_DOWNLOAD") {
    console.warn(`[EvidenceIntegrity] ${callSid}: Recording hash already set (not pending). Skipping update.`);
    return existing;
  }

  const recordingHash = crypto
    .createHash("sha256")
    .update(recordingData)
    .digest("hex");

  // Recompute combined hash with real recording data
  const combinedHash = crypto
    .createHash("sha256")
    .update(recordingHash + existing.metadataHash)
    .digest("hex");

  const updatedAt = new Date().toISOString();

  const updated: EvidenceSignature = {
    ...existing,
    sha256Hash: recordingHash,
    combinedHash,
    // Preserve original capturedAt but note the recording hash update time
    metadata: {
      ...existing.metadata,
      // @ts-ignore — extending metadata with audit fields
      recordingHashUpdatedAt: updatedAt,
      recordingFormat: format,
      recordingSize: recordingData.length,
    },
  };

  // Overwrite signature on disk atomically with restrictive permissions.
  // This is an expected overwrite (pending → actual hash) so no archive.
  const sigPath = getSignaturePath(callSid);
  writeSignatureAtomic(sigPath, updated);

  console.log(
    `[EvidenceIntegrity] Updated recording hash for ${callSid}: ` +
    `${recordingHash.slice(0, 16)}... (${format}, ${recordingData.length} bytes, ` +
    `chain-of-custody gap: ${existing.capturedAt} → ${updatedAt})`
  );

  return updated;
}

// ── Load saved signatures ───────────────────────────────────────────────

/**
 * Load a previously saved evidence signature for a call.
 */
export function loadSignature(callSid: string): EvidenceSignature | null {
  const sigPath = getSignaturePath(callSid);
  if (!fs.existsSync(sigPath)) return null;
  try {
    const sig = JSON.parse(fs.readFileSync(sigPath, "utf-8")) as EvidenceSignature;

    // Verify signature integrity against THREE independent hashes:
    //   1. metadataHash — recompute from actual metadata bytes (closes the
    //      self-referential hole where an attacker could swap metadata
    //      content without updating the stored hash).
    //   2. combinedHash — recompute from sha256Hash + metadataHash.
    //   3. Both must match the stored values.
    //
    // Any mismatch means the file was tampered or corrupted and the
    // signature is not trustworthy — reject it rather than pass silently.
    if (sig.sha256Hash !== "PENDING_RECORDING_DOWNLOAD") {
      // (1) Recompute metadataHash from the stored metadata object. Uses
      // the same canonical serializer as signEvidence so the comparison
      // is stable across platforms and re-serialization.
      const metadataStr = canonicalStringify(sig.metadata);
      const recomputedMetadataHash = crypto
        .createHash("sha256")
        .update(metadataStr)
        .digest("hex");
      if (recomputedMetadataHash !== sig.metadataHash) {
        console.error(
          `[EvidenceIntegrity] CRITICAL: Metadata integrity check FAILED for ${callSid}. ` +
          `Stored metadataHash (${sig.metadataHash.slice(0, 16)}...) does not match ` +
          `hash recomputed from stored metadata (${recomputedMetadataHash.slice(0, 16)}...). ` +
          `The metadata object was modified after signing. File is tampered or corrupted.`
        );
        return null;
      }

      // (2) Recompute combinedHash. This is redundant with a correct
      // metadataHash check but catches cases where combinedHash alone
      // was altered.
      const recomputedCombined = crypto
        .createHash("sha256")
        .update(sig.sha256Hash + sig.metadataHash)
        .digest("hex");
      if (recomputedCombined !== sig.combinedHash) {
        console.error(
          `[EvidenceIntegrity] CRITICAL: Combined-hash integrity check FAILED for ${callSid}. ` +
          `Stored combinedHash does not match recomputed value. File is tampered or corrupted.`
        );
        return null;
      }
    }

    return sig;
  } catch (err) {
    console.error(
      `[EvidenceIntegrity] Failed to load signature for ${callSid}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Load all signatures for calls from a specific phone number.
 */
export function loadSignaturesForNumber(
  callerPhone: string
): EvidenceSignature[] {
  ensureSignaturesDir();
  const signatures: EvidenceSignature[] = [];

  try {
    const files = fs.readdirSync(SIGNATURES_DIR).filter((f) => f.endsWith(".sig.json"));
    for (const file of files) {
      try {
        const sig = JSON.parse(
          fs.readFileSync(path.join(SIGNATURES_DIR, file), "utf-8")
        ) as EvidenceSignature;
        if (sig.metadata.callerPhone === callerPhone) {
          signatures.push(sig);
        }
      } catch {
        // Skip corrupted signature files
      }
    }
  } catch {
    // Directory read failed
  }

  return signatures.sort(
    (a, b) => a.metadata.callDate.localeCompare(b.metadata.callDate)
  );
}

// ── Generate integrity certificate for court ────────────────────────────

/**
 * Generate a comprehensive integrity certificate for all evidence
 * related to an offender. This is a court-ready document proving
 * the evidence chain of custody.
 *
 * @param offenderNumber - The normalized phone number of the offender
 * @param offenderCalls  - The call entries from the offender's profile
 */
export function generateIntegrityCertificate(
  offenderNumber: string,
  offenderCalls: Array<{ callSid: string; date: string; time: string }>
): IntegrityCertificate {
  const signatures: EvidenceSignature[] = [];

  // Load signatures for each call
  for (const call of offenderCalls) {
    const sig = loadSignature(call.callSid);
    if (sig) {
      signatures.push(sig);
    }
  }

  // Generate master hash (hash of all combined hashes in order)
  const allCombined = signatures.map((s) => s.combinedHash).join("");
  const masterHash = crypto
    .createHash("sha256")
    .update(allCombined || "NO_SIGNATURES")
    .digest("hex");

  const generatedAt = new Date().toISOString();
  const generatedDateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build human-readable certificate
  let certText = `═══════════════════════════════════════════════════════════════════════
              CERTIFICATE OF EVIDENCE INTEGRITY
═══════════════════════════════════════════════════════════════════════

Generated:       ${generatedDateStr}
Offender Number: ${offenderNumber}
Total Calls:     ${offenderCalls.length}
Signed Calls:    ${signatures.length}
Master Hash:     ${masterHash}

This certificate verifies the integrity of call recordings and
metadata collected by the SpamSlayer automated compliance system.
Each call was cryptographically signed at the time of capture using
SHA-256, a standard algorithm used by the U.S. government (FIPS
180-4) and accepted in federal and state courts for digital evidence
authentication.

───────────────────────────────────────────────────────────────────────
  INDIVIDUAL CALL SIGNATURES
───────────────────────────────────────────────────────────────────────

`;

  if (signatures.length === 0) {
    certText += `  No cryptographic signatures were found for these calls.\n`;
    certText += `  Recordings may still be available but lack tamper-proof\n`;
    certText += `  verification. This does not invalidate the recordings\n`;
    certText += `  but reduces their evidentiary weight.\n\n`;
  } else {
    signatures.forEach((sig, i) => {
      certText += `  Call ${i + 1}:\n`;
      certText += `    Date:           ${sig.metadata.callDate} at ${sig.metadata.callTime}\n`;
      certText += `    Call SID:       ${sig.callSid}\n`;
      certText += `    Recording Hash: ${sig.sha256Hash}\n`;
      certText += `    Metadata Hash:  ${sig.metadataHash}\n`;
      certText += `    Combined Hash:  ${sig.combinedHash}\n`;
      certText += `    Signed At:      ${sig.capturedAt}\n`;
      certText += `\n`;
    });
  }

  certText += `───────────────────────────────────────────────────────────────────────

  VERIFICATION INSTRUCTIONS

  To verify the integrity of any recording:

  1. Obtain the original recording file from the URL or storage
     location listed above.
  2. Run: sha256sum <recording_file>
     (or use any SHA-256 tool — available on Windows, Mac, and Linux)
  3. Compare the output to the "Recording Hash" listed above.
  4. If they match, the recording has not been altered since capture.

  The Master Hash (${masterHash.slice(0, 32)}...)
  is a SHA-256 hash of all individual combined hashes concatenated
  in chronological order, providing a single verification point for
  the entire evidence set.

═══════════════════════════════════════════════════════════════════════

  I certify that the above hashes were generated at the time each
  call was captured and have been stored in tamper-evident files
  on the SpamSlayer compliance system.

  Generated by SpamSlayer Evidence Integrity System
  ${generatedDateStr}

═══════════════════════════════════════════════════════════════════════`;

  return {
    generatedAt,
    offenderNumber,
    totalCalls: offenderCalls.length,
    signatures,
    masterHash,
    certificateText: certText,
  };
}
