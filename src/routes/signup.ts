// ─────────────────────────────────────────────────────────────────────────────
//  routes/signup.ts — SMS-based signup and command handler
//
//  Shared-number model: everyone texts the SAME SpamSlayer number to sign up,
//  and everyone forwards their spam calls to that SAME number. The bot
//  identifies subscribers via the ForwardedFrom header on incoming calls.
//
//  POST /api/sms/inbound     Twilio SMS webhook
//
//  Commands:
//    START / SIGNUP / JOIN   → Sign up (register your phone number)
//    NAME [full name]        → Set name for legal documents
//    ADDRESS [address]       → Set address for demand letters
//    DNC [year]              → Set DNC registration year
//    CASE / CASES            → Get summary of actionable cases
//    DETAILS [number]        → Get details on a specific offender
//    LETTER [number]         → Generate demand letter for an offender
//    STATUS                  → Account status and stats
//    HELP                    → List available commands
//    STOP                    → Deactivate account
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import twilio from "twilio";
import * as UserManager from "../services/userManager";
import * as CaseBuilder from "../services/caseBuilder";
import * as Notify from "../services/notifications";

const router = Router();
const { MessagingResponse } = twilio.twiml;

/** The single SpamSlayer number everyone forwards calls to. */
const SPAMSLAYER_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? "";

// ── SMS inbound webhook ──────────────────────────────────────────────────

router.post("/inbound", async (req: Request, res: Response) => {
  const { From, Body } = req.body as { From: string; Body: string };
  const text = (Body ?? "").trim();
  const command = text.toUpperCase().split(/\s+/)[0];
  const args = text.slice(command.length).trim();

  const twiml = new MessagingResponse();

  // Check if user exists
  const user = UserManager.getUser(From);

  // ── SIGNUP ───────────────────────────────────────────────────────────
  if (!user && ["START", "SIGNUP", "JOIN", "HI", "HELLO"].includes(command)) {
    const newUser = UserManager.createUser(From);
    await Notify.notifyWelcome(From, SPAMSLAYER_NUMBER);

    // Don't double-send — notifyWelcome already sends the welcome SMS
    res.sendStatus(204);
    return;
  }

  // ── Not signed up yet ────────────────────────────────────────────────
  if (!user) {
    twiml.message(
      "Welcome to SpamSlayer! Text START to sign up and get your spam trap number. " +
      "We'll handle your telemarketer problem from there."
    );
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // ── Commands for existing users ──────────────────────────────────────

  switch (command) {
    case "NAME": {
      if (!args) {
        twiml.message("Reply: NAME Your Full Name\nExample: NAME Marcus Descant");
        break;
      }
      UserManager.updateUser(From, { name: args });
      twiml.message(`Got it! Name set to: ${args}`);

      // Prompt for sex next so the bot matches the user
      if (!user.sex) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "sex"), 2000);
      } else if (!user.address) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "address"), 2000);
      } else if (!user.dncSinceYear) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "dncYear"), 2000);
      } else {
        UserManager.updateUser(From, { onboardingComplete: true });
      }
      break;
    }

    case "SEX": {
      const val = args.toUpperCase().trim();
      if (!["M", "F"].includes(val)) {
        twiml.message("Reply: SEX M or SEX F\nThis makes your bot sound like you.");
        break;
      }
      UserManager.updateUser(From, { sex: val as "M" | "F" });
      twiml.message(`Got it! Your bot will sound ${val === "M" ? "male" : "female"} — just like you.`);

      if (!user.address) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "address"), 2000);
      } else if (!user.dncSinceYear) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "dncYear"), 2000);
      } else {
        UserManager.updateUser(From, { onboardingComplete: true });
      }
      break;
    }

    case "ADDRESS": {
      if (!args) {
        twiml.message("Reply: ADDRESS Your Full Address\nExample: ADDRESS 123 Main St, Lafayette LA 70501");
        break;
      }
      UserManager.updateUser(From, { address: args });
      twiml.message(`Address set to: ${args}`);

      if (!user.dncSinceYear) {
        setTimeout(() => Notify.notifyOnboardingPrompt(From, "dncYear"), 2000);
      } else if (user.name) {
        UserManager.updateUser(From, { onboardingComplete: true });
      }
      break;
    }

    case "DNC": {
      if (!args) {
        twiml.message("Reply: DNC [year]\nExample: DNC 2007\nIf unsure, reply: DNC UNSURE");
        break;
      }
      const year = args.match(/\d{4}/)?.[0] ?? "";
      if (year) {
        UserManager.updateUser(From, { dncSinceYear: year });
        twiml.message(`DNC registration year set to: ${year}`);
      } else if (args.toUpperCase().includes("UNSURE")) {
        twiml.message(
          "No problem! Check at donotcall.gov or call 1-888-382-1222 from your phone " +
          "to verify. Text me the year when you find out."
        );
      } else {
        twiml.message("Reply: DNC [year], e.g. DNC 2007");
      }

      if (user.name && user.address && year) {
        UserManager.updateUser(From, { onboardingComplete: true });
        twiml.message(
          `\nSetup complete! Your SpamSlayer bot is ready. ` +
          `Forward spam calls to ${SPAMSLAYER_NUMBER} and I'll build your cases.`
        );
      }
      break;
    }

    case "CASE":
    case "CASES": {
      const cases = CaseBuilder.getActionableCases(user.id);
      if (cases.length === 0) {
        const summary = CaseBuilder.getCaseSummary(user.id);
        twiml.message(
          `No actionable cases yet. ${summary.totalCalls} call(s) logged from ` +
          `${summary.uniqueOffenders} number(s). Need 2+ calls from the same number ` +
          `to file a TCPA case. Keep forwarding those spam calls!`
        );
      } else {
        let msg = `You have ${cases.length} actionable case(s):\n\n`;
        for (const c of cases.slice(0, 5)) {
          const company = c.companyName ?? "Unknown";
          msg += `${company} (${c.normalizedNumber}): ${c.callCount} calls, $${c.damagesEstimate}\n`;
        }
        msg += `\nTotal potential damages: $${cases.reduce((s, c) => s + c.damagesEstimate, 0).toLocaleString()}`;
        msg += `\n\nReply LETTER [phone number] to generate a demand letter.`;
        twiml.message(msg);
      }
      break;
    }

    case "DETAILS": {
      if (!args) {
        twiml.message("Reply: DETAILS [phone number]\nExample: DETAILS 3375551234");
        break;
      }
      const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(args));
      if (!offender) {
        twiml.message(`No records found for ${args}. Check the number and try again.`);
      } else {
        let msg = `Offender: ${offender.companyName ?? "Unknown Company"}\n`;
        msg += `Number: ${offender.rawNumbers[0]}\n`;
        msg += `Calls: ${offender.callCount}\n`;
        msg += `First call: ${offender.firstCallDate}\n`;
        msg += `Last call: ${offender.lastCallDate}\n`;
        msg += `Actionable: ${offender.actionable ? "YES" : "No (need 2+ calls)"}\n`;
        msg += `Damages: $${offender.damagesEstimate}\n`;
        if (offender.callerNames.length > 0) {
          msg += `Caller names: ${offender.callerNames.join(", ")}\n`;
        }
        if (offender.demandLetterSent) {
          msg += `Demand letter sent: ${offender.demandLetterDate}\n`;
        }
        twiml.message(msg);
      }
      break;
    }

    case "LETTER": {
      if (!args) {
        twiml.message("Reply: LETTER [phone number]\nI'll generate a TCPA demand letter for that offender.");
        break;
      }
      if (!user.name || !user.address) {
        twiml.message(
          "I need your name and address to generate a demand letter. " +
          "Reply NAME [your name] and ADDRESS [your address] first."
        );
        break;
      }
      const key = CaseBuilder.normalizePhone(args);
      const letter = CaseBuilder.generateDemandLetter(
        key,
        user.name,
        user.address,
        user.phone,
        user.dncSinceYear || "the date of registration"
      );
      if (!letter) {
        twiml.message(
          `Can't generate a letter for ${args}. Either the number isn't in our records ` +
          `or it's not actionable yet (need 2+ calls).`
        );
      } else {
        CaseBuilder.markDemandSent(key);
        // SMS has a 1600 char limit — send the key parts
        const preview = letter.slice(0, 1500) + "...\n\n[Full letter available on your dashboard]";
        twiml.message(`DEMAND LETTER GENERATED:\n\n${preview}`);
      }
      break;
    }

    case "STATUS": {
      const summary = CaseBuilder.getCaseSummary(user.id);
      let msg = `SpamSlayer Status for ${user.name ?? "you"}:\n`;
      msg += `Calls logged: ${summary.totalCalls}\n`;
      msg += `Unique spammers: ${summary.uniqueOffenders}\n`;
      msg += `Actionable cases: ${summary.actionableCases}\n`;
      msg += `Potential damages: $${summary.totalDamages.toLocaleString()}\n`;
      msg += `Forward calls to: ${SPAMSLAYER_NUMBER}\n`;
      msg += `Member since: ${user.signupDate}`;
      twiml.message(msg);
      break;
    }

    case "HELP": {
      twiml.message(
        "SpamSlayer Commands:\n" +
        "START — Sign up\n" +
        "NAME [name] — Set your name\n" +
        "ADDRESS [addr] — Set your address\n" +
        "DNC [year] — DNC registration year\n" +
        "CASES — View actionable cases\n" +
        "DETAILS [number] — Offender details\n" +
        "LETTER [number] — Generate demand letter\n" +
        "STATUS — Your account stats\n" +
        "STOP — Deactivate account"
      );
      break;
    }

    case "STOP": {
      UserManager.deactivateUser(From);
      twiml.message(
        "SpamSlayer deactivated. Your case data is saved if you want to come back. " +
        "Text START anytime to reactivate. Thanks for using SpamSlayer!"
      );
      break;
    }

    default: {
      twiml.message(
        `I didn't understand "${text.slice(0, 30)}". Reply HELP for a list of commands.`
      );
    }
  }

  res.type("text/xml").send(twiml.toString());
});

export default router;
