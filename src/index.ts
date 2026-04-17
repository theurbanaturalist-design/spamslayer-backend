// ─────────────────────────────────────────────────────────────────────────────
//  SpamSlayer — TCPA Compliance Bot
//
//  An employee that answers spam calls, engages the caller to extract their
//  company info, records everything, builds legal cases, and texts users
//  when they have an actionable TCPA lawsuit.
//
//  Routes:
//    /api/phone/*     Twilio voice webhooks (spam calls)
//    /api/sms/*       Twilio SMS webhooks (user signup & commands)
//    /api/cases/*     Case data API (for dashboard/frontend)
//    /api/health      Health check
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

// Sanity checks
console.log("[SpamSlayer] GOOGLE_API_KEY:", process.env.GOOGLE_API_KEY ? "defined" : "MISSING");
console.log("[SpamSlayer] TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "defined" : "MISSING");
console.log("[SpamSlayer] TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER ?? "(not set)");

import express from "express";
import cors from "cors";
import { validateTwilio } from "./middleware/validateTwilio";
import phoneRouter from "./routes/phone";
import smsRouter from "./routes/signup";
import * as CaseBuilder from "./services/caseBuilder";
import * as UserManager from "./services/userManager";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);

app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());

// ── Twilio webhook routes (signature-validated) ──────────────────────────
app.use("/api/phone", validateTwilio, phoneRouter);
app.use("/api/sms", validateTwilio, smsRouter);

// ── Public API routes (for frontend dashboard) ───────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "SpamSlayer",
    timestamp: new Date().toISOString(),
    users: UserManager.getUserCount(),
  });
});

// Case summary for a specific user
app.get("/api/cases/summary/:userId", (req, res) => {
  const summary = CaseBuilder.getCaseSummary(req.params.userId);
  res.json(summary);
});

// All actionable cases for a user
app.get("/api/cases/actionable/:userId", (req, res) => {
  const cases = CaseBuilder.getActionableCases(req.params.userId);
  res.json(cases);
});

// All offenders (admin view)
app.get("/api/cases/all", (_req, res) => {
  const offenders = CaseBuilder.getAllOffenders();
  res.json(offenders);
});

// Check if a number is a known offender — used by Reed to route calls
app.get("/api/cases/check", (req, res) => {
  const phone = (req.query.phone as string) || "";
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(phone));
  res.json({ known: !!offender, callCount: offender?.callCount ?? 0 });
});

// Single offender detail
app.get("/api/cases/offender/:number", (req, res) => {
  const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(req.params.number));
  if (!offender) {
    res.status(404).json({ error: "Offender not found" });
    return;
  }
  res.json(offender);
});

// Generate demand letter
app.post("/api/cases/demand-letter", (req, res) => {
  const { number, userName, userAddress, userPhone, dncSince } = req.body;
  const letter = CaseBuilder.generateDemandLetter(
    CaseBuilder.normalizePhone(number),
    userName,
    userAddress,
    userPhone,
    dncSince
  );
  if (!letter) {
    res.status(400).json({ error: "Cannot generate letter — case not actionable or offender not found" });
    return;
  }
  CaseBuilder.markDemandSent(CaseBuilder.normalizePhone(number));
  res.json({ letter });
});

// User management
app.get("/api/users", (_req, res) => {
  res.json(UserManager.getActiveUsers());
});

app.get("/api/users/:phone", (req, res) => {
  const user = UserManager.getUser(req.params.phone);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

// ── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const users = UserManager.getUserCount();
  console.log("═".repeat(55));
  console.log("  SpamSlayer — TCPA Compliance Bot");
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Users: ${users.active} active / ${users.total} total`);
  console.log(`  SpamSlayer number: ${process.env.TWILIO_PHONE_NUMBER ?? "(not set)"}`);
  console.log("  Voice webhook: /api/phone/inbound");
  console.log("  SMS webhook:   /api/sms/inbound");
  console.log("═".repeat(55));
});
