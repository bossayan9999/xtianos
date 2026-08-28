import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { prisma } from "./db";
import { env } from "./env";

export async function audit(action: string, detail: string): Promise<void> {
  await prisma.auditLog.create({ data: { action, detail: detail.slice(0, 2000) } }).catch(() => undefined);
}

// ── scrypt password hashing (no external deps; Node built-in) ────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltB64, hashB64] = parts;
  let key: Buffer;
  try {
    key = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  const N = Number.parseInt(nS, 10);
  const r = Number.parseInt(rS, 10);
  const p = Number.parseInt(pS, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltB64, "base64");
  const calc = crypto.scryptSync(plain, salt, key.length, { N, r, p });
  return crypto.timingSafeEqual(calc, key);
}

// ── TOTP (RFC 6238, HMAC-SHA1, 30s step, 6 digits) ───────────────────────────

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpToken(secretB32: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, "0");
}

export function verifyTotp(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (const delta of [0, -1, 1]) {
    const expected = totpToken(secretB32, now + delta * 30);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function createSession(
  userId: number,
  req: Request,
): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(raw),
      createdIp: req.ip ?? null,
      userAgent: String(req.header("user-agent") ?? "").slice(0, 250) || null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return raw;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revoked: true },
  }).catch(() => undefined);
}

export interface AuthedRequest extends Request {
  user?: {
    id: number;
    username: string;
    displayName: string;
    role: string;
    email: string | null;
    phone: string | null;
    totpEnabled: boolean;
    lockedUntil: Date | null;
  };
  sessionId?: string;
  authMode?: "session" | "service" | "raw-file";
}

// ── Express middleware: Bearer session OR X-Auth-Token service key ────────────

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

/** Look up + validate a session from a raw bearer token (never leaks the token). */
export async function findSessionByRawToken(raw: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });
  if (
    !session ||
    session.revoked ||
    session.expiresAt.getTime() < Date.now() ||
    (session.user.lockedUntil && session.user.lockedUntil.getTime() > Date.now())
  ) {
    return null;
  }
  return session;
}

/**
 * Allow a request through when it carries a valid session (bearer header or
 * `?token=` query for server-rendered <img> tags) or a valid service key.
 * Used by routes that the global middleware defers (e.g. artifact raw files).
 */
export async function authorizeRequestAccess(req: AuthedRequest): Promise<boolean> {
  if (req.authMode === "session" || req.authMode === "service") return true;

  const service = req.header("x-auth-token");
  if (
    env.authToken !== "" &&
    service &&
    Buffer.byteLength(service) === Buffer.byteLength(env.authToken) &&
    crypto.timingSafeEqual(Buffer.from(service), Buffer.from(env.authToken))
  ) {
    req.authMode = "service";
    return true;
  }

  const raw =
    bearerToken(req.header("authorization")) ??
    (typeof req.query["token"] === "string" ? req.query["token"] : null);
  if (!raw) return false;
  const session = await findSessionByRawToken(raw);
  if (!session) return false;
  req.authMode = "session";
  req.sessionId = session.id;
  req.user = {
    id: session.user.id,
    username: session.user.username,
    displayName: session.user.displayName,
    role: session.user.role,
    email: session.user.email,
    phone: session.user.phone,
    totpEnabled: session.user.totpEnabled,
    lockedUntil: session.user.lockedUntil,
  };
  if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
    void prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return true;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Always-open endpoints.
  if (
    req.path === "/health" ||
    req.path === "/api/auth/login" ||
    req.path === "/api/auth/recovery/request" ||
    req.path === "/api/auth/recovery/confirm"
  ) {
    next();
    return;
  }

  // Deferred to the route (raw artifact bytes for <img> tags accept ?token=).
  if (req.path.startsWith("/api/artifacts/") && req.path.endsWith("/raw")) {
    (req as AuthedRequest).authMode = "raw-file";
    next();
    return;
  }

  const authed = req as AuthedRequest;
  // Service key path (machine-to-machine automation).
  if (await authorizeRequestAccess(authed)) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function bootstrapAdmin(): Promise<void> {
  const username = (process.env["ADMIN_USERNAME"] ?? "").trim() || "admin";

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return;

  const requested = process.env["ADMIN_PASSWORD"] ?? "";
  let password = requested;
  if (!password) password = crypto.randomBytes(6).toString("base64url");

  // Create first; a racing watcher-restart may already have created the user.
  // Only the winner proceeds to write the credentials file / warn.
  try {
    await prisma.user.create({
      data: {
        username,
        displayName: username,
        passwordHash: hashPassword(password),
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return; // another process bootstrapped first
    }
    throw error;
  }

  if (!requested) {
    try {
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        path.resolve(process.cwd(), "admin.credentials.txt"),
        `username: ${username}\npassword: ${password}\n\nSet ADMIN_USERNAME / ADMIN_PASSWORD in .env, then delete this file.\n`,
        "utf8",
      );
      console.warn(
        `[auth] DEFAULT admin created for "${username}" — password written to admin.credentials.txt (repo root). Set ADMIN_PASSWORD in .env, then delete the file.`,
      );
    } catch {
      console.warn(
        `[auth] DEFAULT admin created for "${username}" — could not write admin.credentials.txt; password is: ${password}`,
      );
    }
  }

  await audit("auth:bootstrap", `created default admin "${username}"`);
}