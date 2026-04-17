// ─────────────────────────────────────────────────────────────────────────────
//  userManager.ts — Multi-user account management for SpamSlayer
//
//  Shared-number model: all subscribers forward spam calls to ONE Twilio
//  number. When a forwarded call arrives, Twilio's `ForwardedFrom` header
//  tells us which subscriber's phone originally received the spam call.
//  We look up the subscriber by their personal phone number, not by a
//  dedicated Twilio line.
//
//  Users sign up via SMS. Each user gets:
//    - A unique ID
//    - Their phone number (used for lookup + alert delivery)
//    - DNC registration date
//    - Basic profile info for demand letters
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import crypto from "crypto";

const USERS_FILE = path.resolve(__dirname, "../../../users.json");

// ── Types ────────────────────────────────────────────────────────────────

export interface SpamSlayerUser {
  id: string;
  phone: string;                // user's real phone number (also the lookup key)
  name: string | null;
  sex: "M" | "F" | null;       // used to match persona voice and pronouns to the user
  address: string | null;
  dncSinceYear: string;
  signupDate: string;
  active: boolean;
  totalCallsLogged: number;
  totalCasesBuilt: number;
  onboardingComplete: boolean;
  state: string | null;         // US state for jurisdiction
}

type UsersDB = Record<string, SpamSlayerUser>;  // keyed by user phone (normalized)

// ── File I/O ─────────────────────────────────────────────────────────────

function loadUsers(): UsersDB {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveUsers(db: UsersDB): void {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function generateId(): string {
  return "ss_" + crypto.randomBytes(6).toString("hex");
}

// ── User management ──────────────────────────────────────────────────────

export function createUser(phone: string): SpamSlayerUser {
  const db = loadUsers();
  const key = normalizePhone(phone);

  if (db[key]) {
    // Reactivate existing user
    db[key].active = true;
    saveUsers(db);
    return db[key];
  }

  const user: SpamSlayerUser = {
    id: generateId(),
    phone,
    name: null,
    sex: null,
    address: null,
    dncSinceYear: "",
    signupDate: new Date().toISOString().split("T")[0],
    active: true,
    totalCallsLogged: 0,
    totalCasesBuilt: 0,
    onboardingComplete: false,
    state: null,
  };

  db[key] = user;
  saveUsers(db);
  console.log(`[UserManager] New user created: ${user.id} (${phone})`);
  return user;
}

export function getUser(phone: string): SpamSlayerUser | null {
  const db = loadUsers();
  return db[normalizePhone(phone)] ?? null;
}

export function getUserById(id: string): SpamSlayerUser | null {
  const db = loadUsers();
  return Object.values(db).find((u) => u.id === id) ?? null;
}

/** Look up a subscriber by their personal phone number (used with ForwardedFrom). */
export function getUserByPhone(phone: string): SpamSlayerUser | null {
  const db = loadUsers();
  const key = normalizePhone(phone);
  const user = db[key];
  return user?.active ? user : null;
}

export function updateUser(
  phone: string,
  data: Partial<Pick<SpamSlayerUser, "name" | "sex" | "address" | "dncSinceYear" | "state" | "onboardingComplete">>
): SpamSlayerUser | null {
  const db = loadUsers();
  const key = normalizePhone(phone);
  if (!db[key]) return null;

  if (data.name !== undefined) db[key].name = data.name;
  if (data.sex !== undefined) db[key].sex = data.sex;
  if (data.address !== undefined) db[key].address = data.address;
  if (data.dncSinceYear !== undefined) db[key].dncSinceYear = data.dncSinceYear;
  if (data.state !== undefined) db[key].state = data.state;
  if (data.onboardingComplete !== undefined) db[key].onboardingComplete = data.onboardingComplete;

  saveUsers(db);
  return db[key];
}

export function incrementCallCount(phone: string): void {
  const db = loadUsers();
  const key = normalizePhone(phone);
  if (db[key]) {
    db[key].totalCallsLogged++;
    saveUsers(db);
  }
}

export function incrementCaseCount(phone: string): void {
  const db = loadUsers();
  const key = normalizePhone(phone);
  if (db[key]) {
    db[key].totalCasesBuilt++;
    saveUsers(db);
  }
}

export function deactivateUser(phone: string): void {
  const db = loadUsers();
  const key = normalizePhone(phone);
  if (db[key]) {
    db[key].active = false;
    saveUsers(db);
  }
}

export function getActiveUsers(): SpamSlayerUser[] {
  const db = loadUsers();
  return Object.values(db).filter((u) => u.active);
}

export function getUserCount(): { total: number; active: number } {
  const db = loadUsers();
  const all = Object.values(db);
  return { total: all.length, active: all.filter((u) => u.active).length };
}
