import fs from "fs";
import path from "path";
import { gradeConversation, aggregateGrades, type ConversationGrade } from "./src/services/conversationGrader";

const CASES = path.resolve(__dirname, "..", "cases.json");
if (!fs.existsSync(CASES)) {
  console.log("No cases.json — exit.");
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(CASES, "utf-8"));

function reconstructTurns(snippet: string): { role: "caller" | "bot"; text: string }[] {
  // Snippet was joined as "Caller: X | Bot: Y | Caller: Z" up to 300 chars.
  // Split on " | " and map prefix-> role.
  return snippet.split(" | ").map((s) => {
    if (s.startsWith("Caller:")) return { role: "caller" as const, text: s.slice(7).trim() };
    if (s.startsWith("Bot:")) return { role: "bot" as const, text: s.slice(4).trim() };
    return { role: "caller" as const, text: s.trim() };
  });
}

const grades: ConversationGrade[] = [];
let totalOffenders = 0, totalCalls = 0;

for (const [num, off] of Object.entries(db) as any) {
  totalOffenders++;
  for (const c of off.calls ?? []) {
    totalCalls++;
    const turns = c.transcriptSnippet ? reconstructTurns(c.transcriptSnippet) : [];
    const g = gradeConversation({
      callSid: c.callSid,
      companyName: off.companyName,
      callerName: off.callerNames?.[0] ?? null,
      purpose: off.purpose,
      recordingUrl: c.recordingUrl ?? null,
      turns,
    });
    grades.push(g);
    console.log(`  ${num}  ${c.callSid.padEnd(20)}  grade=${g.grade.padEnd(11)} score=${g.score}  hangUp=${g.hangUpRisk}  ${g.summary.slice(0, 80)}`);
  }
}

console.log(`\n=== Aggregate over ${totalOffenders} offender(s), ${totalCalls} call(s) ===`);
const agg = aggregateGrades(grades);
console.log(`  Total: ${agg.totalCalls}  Graded: ${agg.graded}  Incomplete: ${agg.incomplete}`);
console.log(`  Average score: ${agg.averageScore}/100`);
console.log(`  Bands: ${JSON.stringify(agg.bandCounts)}`);
console.log(`  Extraction rates:`);
console.log(`    company:   ${(agg.extractionRates.company*100).toFixed(0)}%`);
console.log(`    name:      ${(agg.extractionRates.name*100).toFixed(0)}%`);
console.log(`    purpose:   ${(agg.extractionRates.purpose*100).toFixed(0)}%`);
console.log(`    recording: ${(agg.extractionRates.recording*100).toFixed(0)}%`);
console.log(`  Hang-up risk: ${JSON.stringify(agg.hangUpRiskCounts)}`);

console.log(`\n[NOTE] cases.json only persists the joined transcript snippet (300-char cap),`);
console.log(`       not the full turns array. Backfilled grades use a reconstructed snippet`);
console.log(`       and may underestimate true conversation quality. Calls logged AFTER the`);
console.log(`       grader rollout will have full-fidelity grades.`);
