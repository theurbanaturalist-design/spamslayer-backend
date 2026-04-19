// ─────────────────────────────────────────────────────────────────────────────
//  spamOrchestrator.ts — Gemini-powered conversation engine for spam calls
//
//  Sam keeps spam callers talking just long enough to extract their company
//  name, then delivers the TCPA/DNC warning. Every word is recorded and
//  becomes evidence in a potential lawsuit.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as Session from "./callSession";
import fs from "fs";
import path from "path";

// ── Load persona once at startup ─────────────────────────────────────────

// Resolve relative to project root (where Render runs the process from)
const PERSONA_PATH = path.resolve(process.cwd(), "persona.json");
const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, "utf-8"));

const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? "");

// ── Types ────────────────────────────────────────────────────────────────

export interface VoiceReply {
  speak: string;
  deliverWarning?: boolean;
  done?: boolean;
  extracted?: {
    company?: string;
    callerName?: string;
    purpose?: string;
  };
}

// ── DNC warning text (read from phone.json or fallback) ──────────────────

const PHONE_CONFIG_PATH = path.resolve(process.cwd(), "phone.json");
let dncWarning = "This number is registered on the National Do Not Call Registry. This call has been recorded and logged as a potential violation of the Telephone Consumer Protection Act. Please remove this number from your call list.";
try {
  const phoneConfig = JSON.parse(fs.readFileSync(PHONE_CONFIG_PATH, "utf-8"));
  if (phoneConfig.dncWarning) dncWarning = phoneConfig.dncWarning;
} catch {}

// ── Build system prompt ──────────────────────────────────────────────────

function buildSystemPrompt(session: Session.CallSession, subscriberName: string | null, subscriberSex: "M" | "F" | null): string {
  const turnCount = session.turns.length;
  const hasCompany = !!session.extractedCompany;
  const hasName = !!session.extractedCallerName;

  const firstName = subscriberName?.split(" ")[0] ?? null;
  const isMale = subscriberSex === "M";

  // Personalise the static persona with the subscriber's actual name and gender
  const identity = firstName
    ? `You are ${firstName}, a ${isMale ? "68-year-old retired man" : "67-year-old retired woman"} who answers the phone a bit slowly. This is YOUR real phone number — telemarketers are calling YOU.`
    : persona.persona_identity;

  const background = firstName
    ? `Your name is ${firstName}. You're a bit hard of hearing, not very tech-savvy, and you get confused easily but you're friendly and you like to chat. You have a ${isMale ? "dog" : "cat"} and you talk about ${isMale ? "him" : "her"} sometimes. You occasionally trail off or ask people to repeat themselves. You sound completely real — not a robot.`
    : persona.persona_background;

  return `${identity}

## Background
${background}

## Tone & Style
${persona.persona_tone}

## Conversation Goals
${persona.persona_goals}

## Boundaries
${persona.persona_boundaries}

## Example Conversations
${persona.example_dialogs.join("\n\n")}

## CRITICAL RULES FOR THIS CALL
- Keep every response to 1-2 SHORT sentences. This is a phone call, not a text chat.
- Sound completely natural and human. Use casual words like "oh cool", "gotcha", "interesting".
- Your FIRST response should ALWAYS be casual and engaging — keep them talking.
- Your #1 goal: get the caller to state their COMPANY NAME and THEIR NAME.
- Ask natural follow-up questions: "Which company are you with?" "And who am I speaking with?" "Do you have a website?"
- ${hasCompany && hasName ? "You have enough info. Deliver the DNC warning NOW." : ""}
- ${!hasCompany && turnCount >= 4 ? "You've had 4+ turns without getting the company name. Deliver the warning anyway." : ""}
- ${turnCount === 0 ? 'This is the START of the call. The caller just started talking. Respond casually like "Oh hey, yeah?" or "Hi! What\'s going on?" to keep them engaged.' : ""}

## SPECIAL TOKENS (append on their own line at the end, NEVER speak these out loud)
- When you identify the company/caller, add: EXTRACTED:company=CompanyName|name=CallerName|purpose=WhatTheySell
- When you are about to deliver the DNC warning, add: WARNING
- When the call should end after the warning, add: DONE
- You can combine: a response can have EXTRACTED + WARNING + DONE all at once

## CURRENT EXTRACTION STATUS
- Company: ${session.extractedCompany ?? "NOT YET IDENTIFIED"}
- Caller name: ${session.extractedCallerName ?? "NOT YET IDENTIFIED"}
- Purpose: ${session.extractedPurpose ?? "UNKNOWN"}
- Warning delivered: ${session.warningDelivered ? "YES" : "NO"}
- Turn count: ${turnCount}`;
}

// ── Main conversation handler ────────────────────────────────────────────

export async function handleSpamTurn(
  callSid: string,
  callerSpeech: string
): Promise<VoiceReply> {
  const session = Session.get(callSid);
  if (!session) {
    return { speak: "Sorry, I'm having trouble. Goodbye.", done: true };
  }

  // Build conversation history
  const historyText = session.turns
    .map((t) => `${t.role === "caller" ? "Caller" : "Sam"}: ${t.text}`)
    .join("\n");

  // Use name/sex stored in session (set from Reed's skill config via URL params)
  const systemPrompt = buildSystemPrompt(session, session.subscriberName, session.subscriberSex);
  const prompt = `${systemPrompt}

${historyText ? `CONVERSATION SO FAR:\n${historyText}\n` : ""}Caller: ${callerSpeech}
Sam:`;

  const model = genai.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  });

  let raw: string;
  try {
    const result = await model.generateContent(prompt);
    raw = result.response.text().trim();
  } catch (err) {
    console.error("[SpamOrchestrator] Gemini error:", err);
    return { speak: "Hmm, sorry, say that again?", deliverWarning: false, done: false };
  }

  // ── Parse special tokens ───────────────────────────────────────────────

  const reply: VoiceReply = { speak: "" };

  // EXTRACTED:company=X|name=Y|purpose=Z
  const extractMatch = raw.match(/EXTRACTED:([^\n]+)/i);
  if (extractMatch) {
    const parts = extractMatch[1];
    const company = parts.match(/company=([^|]+)/i)?.[1]?.trim();
    const callerName = parts.match(/name=([^|]+)/i)?.[1]?.trim();
    const purpose = parts.match(/purpose=([^|]+)/i)?.[1]?.trim();

    reply.extracted = {};
    if (company && company.toLowerCase() !== "unknown") {
      reply.extracted.company = company;
      Session.updateExtracted(callSid, { extractedCompany: company });
    }
    if (callerName && callerName.toLowerCase() !== "unknown") {
      reply.extracted.callerName = callerName;
      Session.updateExtracted(callSid, { extractedCallerName: callerName });
    }
    if (purpose && purpose.toLowerCase() !== "unknown") {
      reply.extracted.purpose = purpose;
      Session.updateExtracted(callSid, { extractedPurpose: purpose });
    }
  }

  // WARNING token
  if (/\bWARNING\b/.test(raw)) {
    reply.deliverWarning = true;
    Session.markWarningDelivered(callSid);
  }

  // DONE token
  if (/\bDONE\b/.test(raw)) {
    reply.done = true;
  }

  // Strip all tokens from spoken text
  let speak = raw
    .replace(/EXTRACTED:[^\n]*/gi, "")
    .replace(/\bWARNING\b/gi, "")
    .replace(/\bDONE\b/gi, "")
    .replace(/\n{2,}/g, " ")
    .trim();

  // If warning is being delivered, append the formal DNC notice
  if (reply.deliverWarning && !session.warningDelivered) {
    speak = speak ? `${speak} ${dncWarning}` : dncWarning;
    reply.done = true; // Always hang up after warning
  }

  reply.speak = speak || "Could you say that again?";

  console.log(
    `[SpamOrchestrator] Turn ${session.turns.length + 1} | ` +
    `Caller: "${callerSpeech.slice(0, 50)}" → Sam: "${reply.speak.slice(0, 50)}..." | ` +
    `Extracted: ${JSON.stringify(reply.extracted ?? {})} | ` +
    `Warning: ${reply.deliverWarning ?? false} | Done: ${reply.done ?? false}`
  );

  return reply;
}

// ── Classify what type of spam call this is (for case categorization) ────

export async function classifyCallType(
  transcript: string
): Promise<"telemarketing" | "robocall" | "scam" | "survey" | "debt_collection" | "unknown"> {
  const model = genai.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  });

  const prompt = `Classify this phone call transcript into exactly one category.
Transcript: "${transcript.slice(0, 500)}"

Categories:
- telemarketing: selling a product or service
- robocall: automated/prerecorded message
- scam: fraudulent (IRS scam, tech support scam, etc.)
- survey: conducting a survey or poll
- debt_collection: collecting a debt
- unknown: can't determine

Reply with ONLY the category name, one word:`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().toLowerCase();
    const valid = ["telemarketing", "robocall", "scam", "survey", "debt_collection"];
    return (valid.includes(text) ? text : "unknown") as any;
  } catch {
    return "unknown";
  }
}
