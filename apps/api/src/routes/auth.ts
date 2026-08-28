import crypto from "node:crypto";
import { Router } from "express";

import { prisma } from "../lib/db";
import {
  audit,
  AuthedRequest,
  createSession,
  generateTotpSecret,
  hashPassword,
  hashToken,
  revokeSession,
  verifyPassword,
  verifyTotp,
} from "../lib/auth";
import { env } from "../lib/env";
import { rateLimit } from "../lib/guard";
import { sendEmail, smtpConfigured } from "../lib/mailer";

export const authRouter = Router();

const otpauthUri = (username: string, secret: string): string =>
  `otpauth://totp/xtiandOS:${encodeURIComponent(username)}?secret=${secret}&issuer=xtiandOS&period=30&digits=6`;

// ── Login (rate limited + lockout after 5 failures) ──────────────────────────

authRouter.post("/login", rateLimit(15 * 60_000, 10, "login"), async (req, res): Promise<void> => {
  const username = typeof req.body?.["username"] === "string" ? req.body["username"].trim() : "";
  const password = typeof req.body?.["password"] === "string" ? req.body["password"] : "";
  const totp = typeof req.body?.["totp"] === "string" ? req.body["totp"].trim() : "";

  if (!username || !password) {
    void audit("auth:login:fail", "missing username/password");
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    void audit("auth:login:fail", username);
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    void audit("auth:login:locked", username);
    res.status(423).json({ error: "account temporarily locked" });
    return;
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const failed = user.failedAttempts + 1;
    const lockedUntil =
      failed >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: failed, lockedUntil } });
    void audit("auth:login:fail", `${username} (attempt ${failed})`);
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  if (user.totpEnabled) {
    if (!user.totpSecret || !verifyTotp(user.totpSecret, totp)) {
      void audit("auth:login:totp-fail", username);
      res.status(401).json({ error: "invalid TOTP code" });
      return;
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
  const token = await createSession(user.id, req);
  void audit("auth:login", username);
  res.json({
    token,
    username: user.username,
    displayName: user.displayName,
    totpEnabled: user.totpEnabled,
  });
});

// ── Authenticated account endpoints ──────────────────────────────────────────

authRouter.get("/me", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  res.json({
    username: authed.user.username,
    displayName: authed.user.displayName,
    role: authed.user.role,
    email: authed.user.email ?? null,
    phone: authed.user.phone ?? null,
    totpEnabled: authed.user.totpEnabled,
  });
});

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

authRouter.put("/account", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const email =
    typeof req.body?.["email"] === "string" ? req.body["email"].trim().toLowerCase() : undefined;
  const phone = typeof req.body?.["phone"] === "string" ? req.body["phone"].trim() : undefined;
  if (email !== undefined && email !== "" && !validateEmail(email)) {
    res.status(400).json({ error: "invalid email address" });
    return;
  }
  const data: { email?: string | null; phone?: string | null } = {};
  if (email !== undefined) data.email = email === "" ? null : email;
  if (phone !== undefined) data.phone = phone === "" ? null : phone;
  if (Object.keys(data).length === 0) {
    res.json({ ok: true });
    return;
  }
  try {
    await prisma.user.update({ where: { id: authed.user.id }, data });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "email already in use" });
      return;
    }
    throw error;
  }
  void audit("auth:account:update", authed.user.username);
  res.json({ ok: true, email: data.email ?? null, phone: data.phone ?? null });
});

// ── Password recovery via email (SMTP) ────────────────────────────────────────

const RECOVERY_TTL_MS = 15 * 60_000;

authRouter.post("/recovery/request", rateLimit(15 * 60_000, 10, "recovery"), async (req, res): Promise<void> => {
  const email = typeof req.body?.["email"] === "string" ? req.body["email"].trim().toLowerCase() : "";
  if (!validateEmail(email)) {
    res.status(400).json({ error: "invalid email" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });

  // Never reveal whether the email exists; always answer ok.
  if (user) {
    void audit("auth:recovery:request", email);
    if (smtpConfigured()) {
      const raw = crypto.randomBytes(32).toString("base64url");
      await prisma.recoveryToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await prisma.recoveryToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(raw),
          expiresAt: new Date(Date.now() + RECOVERY_TTL_MS),
        },
      });
      try {
        await sendEmail({
          to: email,
          subject: "Reset your xtiandOS password",
          text:
            `Someone requested a password reset for ${user.username}.\n\n` +
            `Open this link within 15 minutes to choose a new password:\n\n` +
            `${env.webOrigin}/?recovery=${raw}\n\n` +
            `If you did not request this, ignore this email.\n`,
        });
        void audit("auth:recovery:email-sent", email);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        void audit("auth:recovery:email-fail", `${email} — ${message.slice(0, 200)}`);
      }
      res.json({ ok: true });
      return;
    }
    void audit("auth:recovery:smtp-unconfigured", email);
    res.json({ ok: true, notice: "email recovery is not configured on this server" });
    return;
  }
  void audit("auth:recovery:unknown-email", email);
  res.json({ ok: true, notice: "if an account exists for that email, a link will be sent" });
});

authRouter.post("/recovery/confirm", rateLimit(15 * 60_000, 20, "recovery-confirm"), async (req, res): Promise<void> => {
  const code = typeof req.body?.["code"] === "string" ? req.body["code"].trim() : "";
  const next = typeof req.body?.["next"] === "string" ? req.body["next"] : "";
  if (!code || next.length < 8) {
    res.status(400).json({ error: "invalid code or password (min 8 chars)" });
    return;
  }
  const token = await prisma.recoveryToken.findUnique({ where: { tokenHash: hashToken(code) } });
  if (
    !token ||
    token.usedAt ||
    token.expiresAt.getTime() < Date.now()
  ) {
    res.status(400).json({ error: "invalid or expired recovery link" });
    return;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: token.userId }, data: { passwordHash: hashPassword(next), failedAttempts: 0, lockedUntil: null } }),
    prisma.recoveryToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
    prisma.session.updateMany({ where: { userId: token.userId, revoked: false }, data: { revoked: true } }),
  ]);
  void audit("auth:recovery:password-reset", String(token.userId));
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.sessionId) {
    res.status(401).json({ error: "session required" });
    return;
  }
  await revokeSession(authed.sessionId);
  void audit("auth:logout", authed.user?.username ?? "?");
  res.json({ ok: true });
});

authRouter.get("/sessions", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const sessions = await prisma.session.findMany({
    where: { userId: authed.user.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(
    sessions.map((s) => ({
      id: s.id,
      createdIp: s.createdIp,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      revoked: s.revoked,
      current: s.id === authed.sessionId,
    })),
  );
});

authRouter.delete("/sessions/:id", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const id = String(req.params["id"] ?? "");
  const session = await prisma.session.findFirst({ where: { id, userId: authed.user.id } });
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await revokeSession(id);
  void audit("auth:session:revoke", `${authed.user.username} revoke ${id}`);
  res.json({ ok: true });
});

authRouter.post("/password", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const current = typeof req.body?.["current"] === "string" ? req.body["current"] : "";
  const next = typeof req.body?.["next"] === "string" ? req.body["next"] : "";
  if (next.length < 8) {
    res.status(400).json({ error: "new password must be at least 8 characters" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: authed.user.id } });
  if (!user || !verifyPassword(current, user.passwordHash)) {
    void audit("auth:password:fail", authed.user.username);
    res.status(403).json({ error: "current password incorrect" });
    return;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(next) } }),
    prisma.session.updateMany({ where: { userId: user.id, revoked: false }, data: { revoked: true } }),
  ]);
  const token = await createSession(user.id, req); // fresh session for this device
  void audit("auth:password:change", authed.user.username);
  res.json({ ok: true, token });
});

// ── TOTP enrollment ───────────────────────────────────────────────────────────

authRouter.post("/totp/generate", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: authed.user.id }, data: { totpSecret: secret } });
  res.json({ secret, otpauthUri: otpauthUri(authed.user.username, secret) });
});

authRouter.post("/totp/confirm", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const code = typeof req.body?.["code"] === "string" ? req.body["code"].trim() : "";
  const user = await prisma.user.findUnique({ where: { id: authed.user.id } });
  if (!user?.totpSecret || !verifyTotp(user.totpSecret, code)) {
    void audit("auth:totp:confirm-fail", authed.user.username);
    res.status(400).json({ error: "invalid TOTP code" });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
  void audit("auth:totp:enable", authed.user.username);
  res.json({ ok: true, totpEnabled: true });
});

authRouter.post("/totp/disable", async (req, res): Promise<void> => {
  const authed = req as AuthedRequest;
  if (!authed.user || authed.authMode !== "session") {
    res.status(401).json({ error: "session required" });
    return;
  }
  const password = typeof req.body?.["password"] === "string" ? req.body["password"] : "";
  const code = typeof req.body?.["code"] === "string" ? req.body["code"].trim() : "";
  const user = await prisma.user.findUnique({ where: { id: authed.user.id } });
  if (!user) {
    res.status(401).json({ error: "session required" });
    return;
  }
  if (!verifyPassword(password, user.passwordHash)) {
    void audit("auth:totp:disable-fail", authed.user.username);
    res.status(403).json({ error: "password incorrect" });
    return;
  }
  if (user.totpEnabled && (!user.totpSecret || !verifyTotp(user.totpSecret, code))) {
    void audit("auth:totp:disable-fail", authed.user.username);
    res.status(400).json({ error: "invalid TOTP code" });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: null, totpEnabled: false } });
  void audit("auth:totp:disable", authed.user.username);
  res.json({ ok: true, totpEnabled: false });
});