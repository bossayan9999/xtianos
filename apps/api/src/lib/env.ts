import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

// npm workspaces run this from apps/api, but .env lives at the monorepo root.
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

function readEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const env = {
  port: Number.parseInt(readEnv("PORT", "3101"), 10),
  bind: readEnv("BIND", "127.0.0.1"),
  masterSecret: readEnv("MASTER_SECRET", "dev-insecure-master-secret"),
  authToken: readEnv("AUTH_TOKEN", ""),
  vaultPath: path.resolve(
    readEnv("VAULT_PATH", "/home/kali/Desktop/xtiandOS/vault"),
  ),
  workspaceDir: path.resolve(readEnv("WORKSPACE_DIR", "~/Desktop/xtiandOS/artifacts".replace("~", process.env["HOME"] ?? "/root"))),
  requestTimeoutMs: Number.parseInt(readEnv("REQUEST_TIMEOUT_MS", "120000"), 10),
  webOrigin: readEnv("WEB_ORIGIN", "http://localhost:5174"),
  smtpHost: readEnv("SMTP_HOST", ""),
  smtpPort: Number.parseInt(readEnv("SMTP_PORT", "587"), 10),
  smtpSecure: readEnv("SMTP_SECURE", "0") === "1",
  smtpUser: readEnv("SMTP_USER", ""),
  smtpPass: readEnv("SMTP_PASS", ""),
  smtpFrom: readEnv("SMTP_FROM", "xtiandOS <no-reply@localhost>"),
  judgeModel: readEnv("JUDGE_MODEL", ""),
  embeddingsBaseUrl: readEnv("EMBEDDINGS_BASE_URL", ""),
  embeddingsApiKey: readEnv("EMBEDDINGS_API_KEY", ""),
  embeddingsModel: readEnv("EMBEDDINGS_MODEL", "text-embedding-3-small"),
};

if (!fs.existsSync(env.workspaceDir)) {
  fs.mkdirSync(env.workspaceDir, { recursive: true });
}

/** AES-256-GCM encryption for provider API keys at rest. */
export function encryptSecret(plain: string): string {
  const key = crypto.scryptSync(env.masterSecret, "xtiandos-salt", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (typeof stored !== "string" || stored.length === 0) return "";
  const [ivB64, tagB64, dataB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !dataB64) return "";
  const key = crypto.scryptSync(env.masterSecret, "xtiandos-salt", 32);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}
