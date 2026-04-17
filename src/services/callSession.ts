// ─────────────────────────────────────────────────────────────────────────────
//  callSession.ts — in-memory state for active spam calls
//
//  Each session tracks everything about one spam call: who called, what they
//  said, what company they represent, and whether the DNC warning was delivered.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallSession {
  callSid: string;
  callerPhone: string;       // the spammer's number
  subscriberPhone: string;   // our user who forwarded the call
  subscriberId: string;      // user account ID
  turns: Array<{ role: "caller" | "sam"; text: string }>;
  extractedCompany: string | null;
  extractedCallerName: string | null;
  extractedPurpose: string | null;
  warningDelivered: boolean;
  startTime: Date;
  recordingUrl: string | null;
  recordingSid: string | null;
}

const sessions = new Map<string, CallSession>();

export function getOrCreate(
  callSid: string,
  callerPhone: string,
  subscriberPhone: string,
  subscriberId: string
): CallSession {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      callSid,
      callerPhone,
      subscriberPhone,
      subscriberId,
      turns: [],
      extractedCompany: null,
      extractedCallerName: null,
      extractedPurpose: null,
      warningDelivered: false,
      startTime: new Date(),
      recordingUrl: null,
      recordingSid: null,
    });
  }
  return sessions.get(callSid)!;
}

export function get(callSid: string): CallSession | undefined {
  return sessions.get(callSid);
}

export function addTurn(callSid: string, role: "caller" | "sam", text: string): void {
  const s = sessions.get(callSid);
  if (!s) return;
  s.turns.push({ role, text });
  // Keep last 10 turns to limit prompt size
  if (s.turns.length > 10) s.turns.splice(0, s.turns.length - 10);
}

export function updateExtracted(
  callSid: string,
  data: Partial<Pick<CallSession, "extractedCompany" | "extractedCallerName" | "extractedPurpose">>
): void {
  const s = sessions.get(callSid);
  if (!s) return;
  if (data.extractedCompany !== undefined) s.extractedCompany = data.extractedCompany;
  if (data.extractedCallerName !== undefined) s.extractedCallerName = data.extractedCallerName;
  if (data.extractedPurpose !== undefined) s.extractedPurpose = data.extractedPurpose;
}

export function markWarningDelivered(callSid: string): void {
  const s = sessions.get(callSid);
  if (s) s.warningDelivered = true;
}

export function setRecording(callSid: string, url: string, sid: string): void {
  const s = sessions.get(callSid);
  if (!s) return;
  s.recordingUrl = url;
  s.recordingSid = sid;
}

export function remove(callSid: string): void {
  sessions.delete(callSid);
}

/** Typed log entry for JSON storage / case building. */
export interface LogEntry {
  callSid: string;
  callerPhone: string;
  subscriberPhone: string;
  subscriberId: string;
  turns: Array<{ role: "caller" | "sam"; text: string }>;
  extractedCompany: string | null;
  extractedCallerName: string | null;
  extractedPurpose: string | null;
  warningDelivered: boolean;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  recordingUrl: string | null;
  recordingSid: string | null;
}

/** Flatten session into a typed object for JSON storage / case building. */
export function toLogEntry(callSid: string): LogEntry | null {
  const s = sessions.get(callSid);
  if (!s) return null;
  return {
    callSid: s.callSid,
    callerPhone: s.callerPhone,
    subscriberPhone: s.subscriberPhone,
    subscriberId: s.subscriberId,
    turns: s.turns.map((t) => ({ role: t.role, text: t.text })),
    extractedCompany: s.extractedCompany,
    extractedCallerName: s.extractedCallerName,
    extractedPurpose: s.extractedPurpose,
    warningDelivered: s.warningDelivered,
    startTime: s.startTime.toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - s.startTime.getTime()) / 1000),
    recordingUrl: s.recordingUrl,
    recordingSid: s.recordingSid,
  };
}
