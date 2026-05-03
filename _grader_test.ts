import { gradeConversation, aggregateGrades } from "./src/services/conversationGrader";

// 1. Ideal call: 4 turns, all info extracted, recording, warning at end
const g1 = gradeConversation({
  callSid: "T1",
  companyName: "Acme Roofing",
  callerName: "Brad",
  purpose: "solar panel quote",
  recordingUrl: "https://example.invalid/r.mp3",
  turns: [
    { role: "caller", text: "Hi, I'm calling about your roof." },
    { role: "bot", text: "Oh hey! Which company are you with?" },
    { role: "caller", text: "Acme Roofing, I'm Brad." },
    { role: "bot", text: "Thanks Brad. This number is on the Do Not Call Registry. This call has been recorded as a TCPA violation. Goodbye." },
  ],
});
console.log("Test 1 (ideal):", g1.grade, g1.score, g1.summary);

// 2. Caller hung up after first turn — no info
const g2 = gradeConversation({
  callSid: "T2",
  companyName: null, callerName: null, purpose: null, recordingUrl: null,
  turns: [{ role: "caller", text: "Hello?" }],
});
console.log("Test 2 (hangup):", g2.grade, g2.score, g2.summary);

// 3. Long ramble, only company name, no warning
const g3 = gradeConversation({
  callSid: "T3",
  companyName: "Solar Corp", callerName: null, purpose: null, recordingUrl: "x",
  turns: Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "caller" : "bot",
    text: i % 2 === 0 ? "tell me more about pricing" : "interesting, can you say more?",
  } as any)),
});
console.log("Test 3 (rambled):", g3.grade, g3.score, g3.summary);

// 4. Persona leak — bot says "I'm an AI"
const g4 = gradeConversation({
  callSid: "T4",
  companyName: "X", callerName: "Y", purpose: "z", recordingUrl: "r",
  turns: [
    { role: "caller", text: "are you a robot?" },
    { role: "bot", text: "I'm an AI compliance investigator." },
    { role: "caller", text: "click" },
  ],
});
console.log("Test 4 (leak):", g4.grade, g4.score, g4.factors.find(f=>f.name==="persona_leak")?.reason);

// 5. Token leak — bot output EXTRACTED:
const g5 = gradeConversation({
  callSid: "T5",
  companyName: "X", callerName: "Y", purpose: "z", recordingUrl: "r",
  turns: [
    { role: "caller", text: "I'm with Solar Corp" },
    { role: "bot", text: "EXTRACTED:company=Solar Corp Got it!" },
    { role: "caller", text: "..." },
  ],
});
console.log("Test 5 (token leak):", g5.grade, g5.score, g5.factors.find(f=>f.name==="persona_leak")?.reason);

// 6. Aggregate
const agg = aggregateGrades([g1, g2, g3, g4, g5]);
console.log("\nAggregate:");
console.log("  total:", agg.totalCalls, "graded:", agg.graded, "avgScore:", agg.averageScore);
console.log("  bands:", JSON.stringify(agg.bandCounts));
console.log("  extractionRates:", JSON.stringify(agg.extractionRates));
console.log("  hangUpRisk:", JSON.stringify(agg.hangUpRiskCounts));
