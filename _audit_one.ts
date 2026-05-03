import fs from "fs";
import path from "path";
import { auditTextBlobs } from "./src/services/citationAudit";

const dir = process.argv[2];
const files: string[] = [];
function walk(p: string) {
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp);
    else if (/\.(txt|md)$/i.test(f)) files.push(fp);
  }
}
walk(dir);

const blobs = files.map((f) => ({ file: path.relative(dir, f), text: fs.readFileSync(f, "utf-8") }));
const r = auditTextBlobs(blobs);

console.log(`Files scanned: ${r.scannedFiles.length}`);
console.log(`Citations found: ${r.totalCitationsFound}`);
console.log(`Verified: ${r.byStatus.verified}`);
console.log(`Unverified: ${r.byStatus.unverified}`);
console.log(`Conflict: ${r.byStatus.conflict}`);
console.log();
console.log("=== First 1500 chars of human-readable summary ===");
console.log(r.humanReadable.slice(0, 1500));
