// ─────────────────────────────────────────────────────────────────────────────
//  filingPdfGenerator.ts — Generate court-ready PDF filing documents
//
//  Converts the text-based filing package into properly formatted PDFs
//  with correct margins, fonts, page numbers, and professional layout.
//
//  Uses pdfkit (pure JS, no external dependencies like wkhtmltopdf).
//
//  Usage:
//    import { generateFilingPdfs } from "./filingPdfGenerator";
//    const result = await generateFilingPdfs(normalizedNumber);
//    // → saves PDFs to filings/<caseRef>/
//
//  HARDENING NOTES (round 12):
//   - renderTextToPdf now returns a Promise that resolves only AFTER the
//     PDF stream has fully flushed. The previous version returned before
//     the bytes were written, so trackFile() → fs.statSync() raced against
//     disk and occasionally logged size 0 or threw ENOENT.
//   - generateFilingPdfs is now async. Callers must await.
//   - The output directory is locked down to 0o700 and files to 0o600 —
//     these files contain PII (plaintiff home address, phone, DNC date)
//     and transcripts with redacted-but-present caller metadata.
//   - A realpath check after mkdir defeats symlink-swap attacks on
//     attacker-supplied outputDir values.
//   - On any failure we best-effort unlink every file we tracked, so
//     users don't end up with a half-complete filing package that looks
//     shippable but is missing the verification certificate.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { generateFilingPackage, FilingPackage, FilingConfig } from "./legalFilingGenerator";
import { generateIntegrityCertificate } from "./evidenceIntegrity";
import { evaluateCaseStrength, formatCaseStrengthReport } from "./caseStrengthMeter";
import { getOffender } from "./caseBuilder";

// ── PDF formatting constants ────────────────────────────────────────────

const MARGIN = 72;          // 1 inch margins (72 points)
const FONT_BODY = "Courier"; // Monospace for legal documents
const FONT_BOLD = "Courier-Bold";
const FONT_SIZE_BODY = 11;
const FONT_SIZE_HEADER = 13;
const FONT_SIZE_TITLE = 15;
const LINE_GAP = 4;

// File permission constants. Chosen deliberately: 0o700 / 0o600 restrict
// the generated PII to the current OS user only.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ── Core: render text content to a PDF document ─────────────────────────

/**
 * Render a text document into a well-formatted PDF.
 * Resolves only after the file stream has been fully flushed.
 */
function renderTextToPdf(
  textContent: string,
  outputPath: string,
  title: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: MARGIN,
        bottom: MARGIN,
        left: MARGIN,
        right: MARGIN,
      },
      info: {
        Title: title,
        Author: "SpamSlayer Legal Filing System",
        Subject: "TCPA Small Claims Court Filing",
        Creator: "SpamSlayer",
      },
      bufferPages: true,
    });

    // Open the target file with 0o600 permissions so the PDF is not
    // world-readable even momentarily between create and later chmod.
    const stream = fs.createWriteStream(outputPath, { mode: FILE_MODE });

    let streamDone = false;
    const onFinish = () => {
      if (streamDone) return;
      streamDone = true;
      resolve();
    };
    const onError = (err: Error) => {
      if (streamDone) return;
      streamDone = true;
      reject(err);
    };

    stream.once("finish", onFinish);
    stream.once("error", onError);
    doc.once("error", onError);

    doc.pipe(stream);

    try {
      // Split into lines and render
      const lines = textContent.split("\n");

      for (const line of lines) {
        const trimmed = line.trimEnd();

        // Detect section dividers (═══ or ───)
        if (/^[═]{10,}/.test(trimmed)) {
          doc.moveDown(0.5);
          doc
            .moveTo(MARGIN, doc.y)
            .lineTo(doc.page.width - MARGIN, doc.y)
            .lineWidth(2)
            .stroke();
          doc.moveDown(0.5);
          continue;
        }

        if (/^[─]{10,}/.test(trimmed) || /^\s+[─]{10,}/.test(trimmed)) {
          doc.moveDown(0.3);
          doc
            .moveTo(MARGIN, doc.y)
            .lineTo(doc.page.width - MARGIN, doc.y)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.3);
          continue;
        }

        // Detect all-caps headers (centered section titles)
        const isCenteredHeader =
          trimmed.length > 5 &&
          trimmed.length < 70 &&
          trimmed === trimmed.toUpperCase() &&
          /^[\sA-Z.§()&,:'—\-\/]+$/.test(trimmed) &&
          !/^[\s]*[═─]/.test(trimmed);

        if (isCenteredHeader && trimmed.trim().length > 3) {
          doc.moveDown(0.3);
          doc
            .font(FONT_BOLD)
            .fontSize(FONT_SIZE_HEADER)
            .text(trimmed.trim(), { align: "center", lineGap: LINE_GAP });
          doc.moveDown(0.3);
          doc.font(FONT_BODY).fontSize(FONT_SIZE_BODY);
          continue;
        }

        // Detect Roman numeral section headers (I., II., III., etc.)
        if (/^\s+(I{1,3}V?|VI{0,3}|IX|X)\.\s/.test(trimmed)) {
          doc.moveDown(0.3);
          doc
            .font(FONT_BOLD)
            .fontSize(FONT_SIZE_HEADER)
            .text(trimmed.trim(), { lineGap: LINE_GAP });
          doc.moveDown(0.2);
          doc.font(FONT_BODY).fontSize(FONT_SIZE_BODY);
          continue;
        }

        // Empty lines → paragraph spacing
        if (trimmed === "") {
          doc.moveDown(0.5);
          continue;
        }

        // Signature lines (underscores)
        if (/^_{4,}/.test(trimmed) || /^\s+_{4,}/.test(trimmed)) {
          doc.moveDown(0.5);
          doc
            .moveTo(MARGIN, doc.y)
            .lineTo(MARGIN + 250, doc.y)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.5);
          continue;
        }

        // Check for page overflow before writing
        if (doc.y > doc.page.height - MARGIN - 30) {
          doc.addPage();
        }

        // Regular text
        doc
          .font(FONT_BODY)
          .fontSize(FONT_SIZE_BODY)
          .text(trimmed, { lineGap: LINE_GAP });
      }

      // Add page numbers to all pages
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc
          .font(FONT_BODY)
          .fontSize(9)
          .text(
            `Page ${i + 1} of ${pageCount}`,
            MARGIN,
            doc.page.height - MARGIN + 20,
            { align: "center", width: doc.page.width - MARGIN * 2 }
          );
      }

      doc.end();
    } catch (err) {
      // If rendering blows up, destroy the stream so the file handle is
      // closed and the partial file can be unlinked by the caller.
      try { stream.destroy(err instanceof Error ? err : new Error(String(err))); }
      catch { /* best effort */ }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────

export interface PdfFilingResult {
  dir: string;
  files: string[];
  caseRef: string;
}

/**
 * Generate a complete set of court-ready PDFs for an actionable case.
 *
 * Produces:
 *   - Petition (PDF)
 *   - Exhibit List (PDF)
 *   - Certificate of Service (PDF)
 *   - Filing Guide (PDF)
 *   - Case Strength Report (PDF)
 *   - Evidence Integrity Certificate (PDF, if signatures exist)
 *   - Summary JSON
 *
 * @param normalizedNumber - The offender's normalized phone number
 * @param outputDir        - Optional output directory (must be under filings/)
 * @param configOverrides  - Optional filing config overrides
 */
export async function generateFilingPdfs(
  normalizedNumber: string,
  outputDir?: string,
  configOverrides?: Partial<FilingConfig>
): Promise<PdfFilingResult | null> {
  // Generate the text-based filing package first
  const pkg = generateFilingPackage(normalizedNumber, configOverrides);
  if (!pkg) return null;

  const offender = getOffender(normalizedNumber);
  if (!offender) return null;

  // Determine output directory. The base is always under cwd/filings so
  // a hostile outputDir cannot escape the project tree.
  const baseDir = path.resolve(process.cwd(), "filings");
  let dir: string;

  if (outputDir) {
    const resolvedDir = path.resolve(outputDir);
    // Require a path-separator-aware prefix check so "/a/filingsX" doesn't
    // pass as being under "/a/filings".
    const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (resolvedDir !== baseDir && !resolvedDir.startsWith(baseWithSep)) {
      throw new Error(
        `[FilingPdf] Security: output must be under ${baseDir}, got ${resolvedDir}`
      );
    }
    dir = resolvedDir;
  } else {
    dir = path.join(baseDir, pkg.caseNumber);
  }

  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  // Re-resolve symlinks AFTER mkdir and verify we're still under baseDir.
  // This defeats a symlink-swap attack where an attacker replaces the
  // directory we just created with a symlink to somewhere else.
  const realDir = fs.realpathSync(dir);
  const realBase = fs.realpathSync(baseDir);
  const realBaseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
  if (realDir !== realBase && !realDir.startsWith(realBaseWithSep)) {
    throw new Error(
      `[FilingPdf] Security: realpath escaped baseDir (real=${realDir}, base=${realBase})`
    );
  }

  // Tighten permissions on the directory itself — mkdirSync's `mode` is
  // masked by umask, so the explicit chmod guarantees 0o700.
  try { fs.chmodSync(realDir, DIR_MODE); } catch { /* best effort */ }

  const files: string[] = [];
  const caseRef = pkg.caseNumber;

  // Helper to track files. Only called AFTER the write has been awaited,
  // so fs.statSync here no longer races the PDF stream's finish event.
  const trackFile = (filepath: string) => {
    files.push(filepath);
    try {
      // Lock down permissions for any file we write (PDF stream already
      // set 0o600 but explicit chmod hardens text/json paths too).
      fs.chmodSync(filepath, FILE_MODE);
    } catch { /* best effort */ }
    try {
      const size = fs.statSync(filepath).size;
      console.log(`  → ${path.basename(filepath)} (${size} bytes)`);
    } catch {
      console.log(`  → ${path.basename(filepath)}`);
    }
  };

  const rollback = () => {
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* best effort */ }
    }
  };

  console.log(`[FilingPdf] Generating PDFs for ${caseRef}...`);

  try {
    // 1. Petition PDF
    const petitionPath = path.join(realDir, `${caseRef}_petition.pdf`);
    await renderTextToPdf(pkg.petition, petitionPath, `Petition — ${caseRef}`);
    trackFile(petitionPath);

    // 2. Exhibit List PDF
    const exhibitsPath = path.join(realDir, `${caseRef}_exhibits.pdf`);
    await renderTextToPdf(pkg.exhibitList, exhibitsPath, `Exhibit List — ${caseRef}`);
    trackFile(exhibitsPath);

    // 3. Certificate of Service PDF
    const servicePath = path.join(realDir, `${caseRef}_certificate_of_service.pdf`);
    await renderTextToPdf(pkg.certificateOfService, servicePath, `Certificate of Service — ${caseRef}`);
    trackFile(servicePath);

    // 4. Filing Guide PDF
    const guidePath = path.join(realDir, `${caseRef}_filing_guide.pdf`);
    await renderTextToPdf(pkg.filingGuide, guidePath, `Filing Guide — ${caseRef}`);
    trackFile(guidePath);

    // 5. Case Strength Report PDF
    const strengthReport = evaluateCaseStrength(normalizedNumber);
    if (strengthReport) {
      const strengthText = formatCaseStrengthReport(strengthReport);
      const strengthPath = path.join(realDir, `${caseRef}_case_strength.pdf`);
      await renderTextToPdf(strengthText, strengthPath, `Case Strength — ${caseRef}`);
      trackFile(strengthPath);
    }

    // 6. Evidence Integrity Certificate PDF (if signatures exist)
    const integrityCert = generateIntegrityCertificate(
      normalizedNumber,
      offender.calls.map((c) => ({
        callSid: c.callSid,
        date: c.date,
        time: c.time,
      }))
    );
    if (integrityCert.signatures.length > 0) {
      const integrityPath = path.join(realDir, `${caseRef}_evidence_integrity.pdf`);
      await renderTextToPdf(
        integrityCert.certificateText,
        integrityPath,
        `Evidence Integrity — ${caseRef}`
      );
      trackFile(integrityPath);
    }

    // 7. Also save text versions for reference
    const txtDir = path.join(realDir, "text");
    fs.mkdirSync(txtDir, { recursive: true, mode: DIR_MODE });
    try { fs.chmodSync(txtDir, DIR_MODE); } catch { /* best effort */ }

    const petitionTxt = path.join(txtDir, `${caseRef}_petition.txt`);
    fs.writeFileSync(petitionTxt, pkg.petition, { encoding: "utf-8", mode: FILE_MODE });
    trackFile(petitionTxt);

    const exhibitsTxt = path.join(txtDir, `${caseRef}_exhibits.txt`);
    fs.writeFileSync(exhibitsTxt, pkg.exhibitList, { encoding: "utf-8", mode: FILE_MODE });
    trackFile(exhibitsTxt);

    const serviceTxt = path.join(txtDir, `${caseRef}_certificate_of_service.txt`);
    fs.writeFileSync(serviceTxt, pkg.certificateOfService, { encoding: "utf-8", mode: FILE_MODE });
    trackFile(serviceTxt);

    const guideTxt = path.join(txtDir, `${caseRef}_filing_guide.txt`);
    fs.writeFileSync(guideTxt, pkg.filingGuide, { encoding: "utf-8", mode: FILE_MODE });
    trackFile(guideTxt);

    // 8. Summary JSON
    const summaryPath = path.join(realDir, `${caseRef}_summary.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({
      caseNumber: caseRef,
      generatedDate: pkg.generatedDate,
      offenderNumber: normalizedNumber,
      offenderCompany: offender.companyName,
      damagesRequested: pkg.damagesRequested,
      caseStrength: strengthReport?.rating ?? "UNKNOWN",
      caseScore: strengthReport?.score ?? 0,
      warnings: pkg.warnings,
      hasIntegrityCert: integrityCert.signatures.length > 0,
      masterHash: integrityCert.masterHash,
      files: files.map((f) => path.basename(f)),
    }, null, 2), { encoding: "utf-8", mode: FILE_MODE });
    trackFile(summaryPath);

    console.log(`[FilingPdf] Complete: ${files.length} files in ${realDir}`);

    return { dir: realDir, files, caseRef };
  } catch (err) {
    console.error(`[FilingPdf] Generation failed — rolling back partial files:`, err);
    rollback();
    throw err;
  }
}
