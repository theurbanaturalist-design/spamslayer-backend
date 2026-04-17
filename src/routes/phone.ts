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

const router = Router();
const { VoiceResponse } = twilio.twiml;

/** Pick a voice that matches the subscriber's gender. Falls back to female. */
function getVoice(sex: "M" | "F" | null): string {
  return sex === "M" ? "Polly.Matthew" : "Polly.Joanna";
}

// ── Helper: speak + gather next turn ─────────────────────────────────────

function speak(res: Response, text: string, action: string, hangup = false, voice = "Polly.Joanna") {
  const twiml = new VoiceResponse();

  if (hangup) {
    twiml.say({ voice }, text);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: ["speech"],
      action,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto",
      language: "en-US",
    });
    gather.say({ voice }, text);
    twiml.say({ voice }, "Hello? Are you still there?");
    const gather2 = twiml.gather({
      input: ["speech"],
      action,
      method: "POST",
      timeout: 5,
      speechTimeout: "auto",
      language: "en-US",
    });
    gather2.say({ voice }, "");
    twiml.say({ voice }, "Alright, goodbye.");
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

  console.log(`[Phone] Inbound call: ${From} → ${To} (forwarded from: ${ForwardedFrom ?? "unknown"}) (${CallSid})`);

  // Shared-number model: ForwardedFrom tells us which subscriber forwarded this call.
  // If the carrier strips it, we still answer and build spammer data — we just can't
  // tie it to a specific user until they claim it (or we ask all active subscribers).
  const user = ForwardedFrom ? UserManager.getUserByPhone(ForwardedFrom) : null;
  const subscriberId = user?.id ?? "unknown";
  const subscriberPhone = user?.phone ?? (ForwardedFrom ?? "");
  const voice = getVoice(user?.sex ?? null);

  // Create session
  Session.getOrCreate(CallSid, From, subscriberPhone, subscriberId);

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

  const gather = twiml.gather({
    input: ["speech"],
    action: "/api/phone/respond",
    method: "POST",
    timeout: 8,
    speechTimeout: "auto",
    language: "en-US",
  });
  gather.say({ voice }, "Hello?");

  twiml.say({ voice }, "Hello, who's this?");
  const gather2 = twiml.gather({
    input: ["speech"],
    action: "/api/phone/respond",
    method: "POST",
    timeout: 5,
    speechTimeout: "auto",
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
    twiml.say({ voice: "Polly.Joanna" }, "Sorry, I'm having trouble. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Resolve voice from subscriber's gender
  const subscriber = session.subscriberPhone
    ? UserManager.getUserByPhone(session.subscriberPhone)
    : null;
  const voice = getVoice(subscriber?.sex ?? null);

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
