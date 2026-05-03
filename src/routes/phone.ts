// ─────────────────────────────────────────────────────────────────────────────
//  routes/phone.ts — SpamSlayer Twilio voice webhooks
//
//  POST /api/phone/inbound          Spam call comes in (forwarded from user's phone)
//  POST /api/phone/respond          Each conversation turn with the spammer
//  POST /api/phone/recording         Recording callback — stores the recording URL
//  POST /api/phone/status            Call status callback (completed, no-answer, etc.)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import twilio from "twilio";
import * as Session from "../services/callSession";
import { handleSpamTurn, classifyCallType } from "../services/spamOrchestrator";
import * as CaseBuilder from "../services/caseBuilder";
import * as UserManager from "../services/userManager";
import * as Notify from "../services/notifications";
import { signEvidence } from "../services/evidenceIntegrity";
// updateRecordingHash is intentionally not imported here — it's needed when
// we eventually download the audio bytes and want to upgrade the hash from
// PENDING_RECORDING_DOWNLOAD to a real SHA-256 of the bytes. That requires
// an authenticated GET against the Twilio recording URL plus a buffer-based
// hash update path; tracked as a follow-up.

const router = Router();
const { VoiceResponse } = twilio.twiml;

// ── Recording polling fallback (P1.3) ──────────────────────────────────────
// Twilio's recording-status webhook is best-effort. Network blips, retry
// exhaustion, and free-tier outages can prevent it from ever firing. If the
// petition is generated based on missing recordings, the case is unwinnable.
// As a backstop, schedule a poll against Twilio's REST API at 30s/2min/5min
// after a call's recording is started. If we already have a recording URL
// for the callSid (because the webhook DID fire), we no-op.

const POLL_DELAYS_MS = [30_000, 120_000, 300_000];
const inFlightPolls = new Set<string>();  // callSids we've already scheduled

function schedulePollForRecording(callSid: string): void {
  if (!callSid || inFlightPolls.has(callSid)) return;
  inFlightPolls.add(callSid);

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.warn(`[Phone] Recording-poll skipped for ${callSid}: TWILIO_ACCOUNT_SID/AUTH_TOKEN not set.`);
    return;
  }
  const client = twilio(accountSid, authToken);

  POLL_DELAYS_MS.forEach((delay) => {
    setTimeout(async () => {
      try {
        // Fast bail if we already attached a recording (the webhook fired).
        const session = Session.get(callSid);
        if (session?.recordingUrl) return;

        const recs = await client.recordings.list({ callSid, limit: 1 });
        if (recs.length === 0) return;

        const rec = recs[0];
        const url = `https://api.twilio.com${rec.uri.replace(/\.json$/, "")}.mp3`;
        const found = CaseBuilder.attachRecording(callSid, url);
        if (session) Session.setRecording(callSid, url, rec.sid);
        if (found) {
          console.log(`[Phone] Polling backfill: attached recording ${rec.sid} to ${callSid} (Twilio webhook never fired)`);
          // Best-effort metadata signature so the chain-of-custody record exists.
          // updateRecordingHash with downloaded bytes is left for a future pass —
          // requires authenticated GET against the recording URL.
          try {
            const sess = Session.get(callSid);
            signEvidence(callSid, null, {
              callSid,
              callerPhone: sess?.callerPhone ?? "unknown",
              subscriberPhone: sess?.subscriberPhone ?? "unknown",
              callDate: new Date().toISOString().split("T")[0],
              callTime: new Date().toTimeString().slice(0, 5),
              recordingUrl: url,
              recordingSid: rec.sid,
              transcriptSnippet: (sess?.turns ?? []).map((t) => `${t.role}:${t.text}`).join("|").slice(0, 300),
              capturedAt: new Date().toISOString(),
            });
          } catch (signErr) {
            console.warn(`[Phone] signEvidence failed for ${callSid} during poll backfill:`, signErr);
          }
          // Don't run the remaining polls.
          inFlightPolls.delete(callSid);
        }
      } catch (err) {
        console.warn(`[Phone] Recording poll failed for ${callSid}:`, (err as Error)?.message ?? err);
      }
    }, delay).unref?.();
  });

  // Stop tracking after the longest delay so the Set doesn't grow unbounded.
  setTimeout(() => inFlightPolls.delete(callSid), POLL_DELAYS_MS[POLL_DELAYS_MS.length - 1] + 5_000).unref?.();
}

/** Pick a voice that matches the subscriber's gender. Falls back to female. */
function getVoice(sex: "M" | "F" | null): string {
  return sex === "M" ? "Polly.Matthew-Neural" : "Polly.Joanna-Neural";
}

// ── Helper: speak + gather next turn ─────────────────────────────────────

function speak(res: Response, text: string, action: string, hangup = false, voice = "Polly.Joanna-Neural") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = voice as any;
  const twiml = new VoiceResponse();

  if (hangup) {
    twiml.say({ voice: v }, text);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: ["speech"],
      action,
      method: "POST",
      timeout: 3,
      speechTimeout: "1",
      language: "en-US",
    });
    gather.say({ voice: v }, text);
    twiml.say({ voice: v }, "Hello? Are you still there?");
    const gather2 = twiml.gather({
      input: ["speech"],
      action,
      method: "POST",
      timeout: 3,
      speechTimeout: "1",
      language: "en-US",
    });
    gather2.say({ voice: v }, "");
    twiml.say({ voice: v }, "Alright, goodbye.");
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
}

// ── POST /api/phone/inbound ──────────────────────────────────────────────
//
// Twilio hits this when a call arrives at one of our numbers.
// We figure out which subscriber owns this number, create a session,
// start recording, and answer with Sam's casual greeting.

router.post("/inbound", (req: Request, res: Response) => {
  const { CallSid, From, To, ForwardedFrom } = req.body as {
    CallSid: string;
    From: string;
    To: string;
    ForwardedFrom?: string;  // subscriber's personal number (set by carrier forwarding)
  };

  // Reed passes subscriber identity as query params when redirecting spam here
  const subName = req.query.subName ? decodeURIComponent(req.query.subName as string) : null;
  const subSexRaw = req.query.subSex ? decodeURIComponent(req.query.subSex as string).toUpperCase() : null;
  const subSex: "M" | "F" | null = subSexRaw === "M" || subSexRaw === "F" ? subSexRaw : null;

  console.log(`[Phone] Inbound call: ${From} → ${To} (forwarded from: ${ForwardedFrom ?? "unknown"}) (${CallSid}) sub=${subName ?? "unknown"} sex=${subSex ?? "?"}`);

  // If Reed passed identity via URL params, prefer those. Otherwise fall back to UserManager.
  const user = (!subName && ForwardedFrom) ? UserManager.getUserByPhone(ForwardedFrom) : null;
  const subscriberId = user?.id ?? "unknown";
  const subscriberPhone = user?.phone ?? (ForwardedFrom ?? "");

  const resolvedSex = subSex ?? user?.sex ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voice = getVoice(resolvedSex) as any;

  // Create session — store name/sex so orchestrator doesn't need UserManager lookup
  Session.getOrCreate(CallSid, From, subscriberPhone, subscriberId, subName, resolvedSex);

  // Start recording the entire call
  const twiml = new VoiceResponse();
  twiml.record({
    action: "/api/phone/recording",
    method: "POST",
    recordingStatusCallback: "/api/phone/recording",
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: ["completed"],
    trim: "trim-silence",
    maxLength: 120,
    playBeep: false,
    transcribe: false,
  });

  // P1.3: schedule polling fallback in case the recording-status webhook
  // never fires. This is fire-and-forget — it'll silently no-op if the
  // webhook DID fire and beat us to attaching the URL.
  schedulePollForRecording(CallSid);

  const gather = twiml.gather({
    input: ["speech"],
    action: "/api/phone/respond",
    method: "POST",
    timeout: 3,
    speechTimeout: "1",
    language: "en-US",
  });
  gather.say({ voice }, "Hello?");

  twiml.say({ voice }, "Hello, who's this?");
  const gather2 = twiml.gather({
    input: ["speech"],
    action: "/api/phone/respond",
    method: "POST",
    timeout: 3,
    speechTimeout: "1",
    language: "en-US",
  });
  gather2.say({ voice }, "");
  twiml.hangup();

  res.type("text/xml").send(twiml.toString());
});

// ── POST /api/phone/respond ──────────────────────────────────────────────
//
// Each back-and-forth turn with the spam caller.
// Sam's AI processes what they said and decides whether to keep chatting
// or deliver the DNC warning.

router.post("/respond", async (req: Request, res: Response) => {
  const { CallSid, From, SpeechResult } = req.body as {
    CallSid: string;
    From: string;
    SpeechResult?: string;
  };

  const session = Session.get(CallSid);
  if (!session) {
    const twiml = new VoiceResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    twiml.say({ voice: "Polly.Joanna-Neural" as any }, "Sorry, I'm having trouble. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Resolve voice from session (set at inbound from Reed's skill config)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voice = getVoice(session.subscriberSex) as any;

  if (!SpeechResult?.trim()) {
    speak(res, "Sorry, I didn't catch that. Could you say that again?", "/api/phone/respond", false, voice);
    return;
  }

  Session.addTurn(CallSid, "caller", SpeechResult);
  const reply = await handleSpamTurn(CallSid, SpeechResult);
  Session.addTurn(CallSid, "sam", reply.speak);

  if (reply.extracted) {
    Session.updateExtracted(CallSid, {
      extractedCompany: reply.extracted.company ?? session.extractedCompany,
      extractedCallerName: reply.extracted.callerName ?? session.extractedCallerName,
      extractedPurpose: reply.extracted.purpose ?? session.extractedPurpose,
    });
  }

  speak(res, reply.speak, "/api/phone/respond", reply.done ?? false, voice);
});

// ── POST /api/phone/recording ────────────────────────────────────────────
//
// Twilio calls this when a recording is ready.
// We store the URL and finalize the case entry.

router.post("/recording", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingStatus } = req.body as {
    CallSid: string;
    RecordingUrl?: string;
    RecordingSid?: string;
    RecordingStatus?: string;
  };

  res.sendStatus(204); // Acknowledge immediately

  if (RecordingStatus !== "completed" || !RecordingUrl) return;

  console.log(`[Phone] Recording ready for ${CallSid}: ${RecordingUrl}`);

  const session = Session.get(CallSid);
  if (!session) return;

  Session.setRecording(CallSid, RecordingUrl, RecordingSid ?? "");

  // Build a transcript snippet from conversation turns
  const snippet = session.turns
    .map((t) => `${t.role === "caller" ? "Caller" : "Sam"}: ${t.text}`)
    .join(" | ")
    .slice(0, 300);

  // P1.4: cryptographically sign the call as it's captured. This is what
  // populates the Evidence Integrity Certificate in the filing exhibit list.
  // Without this call, every petition reads "0 signed calls" which weakens
  // the chain-of-custody claim. We sign with null buffer (PENDING_RECORDING_DOWNLOAD)
  // because we have the URL, not the audio bytes; updateRecordingHash can be
  // called later after a separate downloader fetches the audio from Twilio.
  try {
    signEvidence(CallSid, null, {
      callSid: CallSid,
      callerPhone: session.callerPhone,
      subscriberPhone: session.subscriberPhone,
      callDate: new Date().toISOString().split("T")[0],
      callTime: new Date().toTimeString().slice(0, 5),
      recordingUrl: RecordingUrl,
      recordingSid: RecordingSid ?? null,
      transcriptSnippet: snippet,
      capturedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[Phone] signEvidence failed for ${CallSid}:`, (err as Error)?.message ?? err);
    // Don't block the rest of the recording flow — better to log the call
    // without a signature than to drop it on the floor.
  }

  // Classify the call type
  const callType = await classifyCallType(snippet);

  // Log to case builder — this checks the 2-call threshold
  const { offender, isNewlyActionable } = CaseBuilder.logCall(
    session.subscriberId,
    session.callerPhone,
    session.extractedCompany,
    session.extractedCallerName,
    session.extractedPurpose,
    CallSid,
    RecordingUrl,
    snippet,
    callType
  );

  // Update user stats
  UserManager.incrementCallCount(session.subscriberPhone);

  // Notify the user
  if (session.subscriberPhone) {
    await Notify.notifyCallLogged(
      session.subscriberPhone,
      session.callerPhone,
      offender.companyName,
      offender.callCount
    );

    // If this call made the case actionable, send the big alert!
    if (isNewlyActionable) {
      UserManager.incrementCaseCount(session.subscriberPhone);
      await Notify.notifyCaseActionable(
        session.subscriberPhone,
        offender.companyName,
        session.callerPhone,
        offender.callCount,
        offender.damagesEstimate
      );
    }
  }

  // Clean up session after a delay (keep it around briefly for any late callbacks)
  setTimeout(() => Session.remove(CallSid), 60_000);
});

// ── POST /api/phone/status ───────────────────────────────────────────────
//
// Twilio status callbacks for when calls end abnormally.

router.post("/status", (req: Request, res: Response) => {
  const { CallSid, CallStatus } = req.body as {
    CallSid: string;
    CallStatus: string;
  };

  res.sendStatus(204);

  if (["no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
    const session = Session.get(CallSid);
    if (session) {
      console.log(`[Phone] Call ${CallSid} ended: ${CallStatus}`);
      // Still log the attempt — caller hung up but the call happened
      if (CallStatus !== "canceled") {
        CaseBuilder.logCall(
          session.subscriberId,
          session.callerPhone,
          session.extractedCompany,
          session.extractedCallerName,
          session.extractedPurpose,
          CallSid,
          null, // no recording
          "Caller hung up before conversation completed",
          "unknown"
        );
      }
      Session.remove(CallSid);
    }
  }
});

export default router;
