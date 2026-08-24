import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { Router } from "express";

import { env } from "../lib/env";
import { prisma } from "../lib/db";
import { decryptSecret } from "../lib/env";

export const voiceRouter = Router();

interface VoiceProvider {
  baseUrl: string;
  apiKey: string;
}

/** Keyed openai-compat providers, audio-capable ones first. */
async function listVoiceProviders(): Promise<VoiceProvider[]> {
  const providers = await prisma.provider.findMany();
  const usable = providers
    .filter((p) => p.kind === "openai-compat" && p.apiKeyEnc)
    .map((p) => ({ baseUrl: p.baseUrl, apiKey: decryptSecret(p.apiKeyEnc as string) }));
  // official OpenAI is the only one guaranteed to host audio endpoints
  const knownAudio = usable.filter((p) => p.baseUrl.includes("api.openai.com"));
  const rest = usable.filter((p) => !p.baseUrl.includes("api.openai.com"));
  return [...knownAudio, ...rest];
}

const run = promisify(execFile);
const EDGE_VOICES: Record<string, string> = {
  nova: "en-US-AvaNeural",
  shimmer: "en-US-EmmaNeural",
  fable: "en-GB-SoniaNeural",
  alloy: "en-US-AriaNeural",
  echo: "en-US-GuyNeural",
  onyx: "en-US-ChristopherNeural",
};

let edgeAvailable: boolean | null = null;
async function edgeTtsInstalled(): Promise<boolean> {
  if (edgeAvailable !== null) return edgeAvailable;
  try {
    await run("python3", ["-m", "edge_tts", "--help"], { timeout: 15_000 });
    edgeAvailable = true;
  } catch {
    edgeAvailable = false;
  }
  return edgeAvailable;
}

/** Local neural TTS via edge-tts (free Microsoft voices) -> mp3 buffer. */
async function speakWithEdgeTts(
  text: string,
  voiceId: string,
  speed: number,
): Promise<Buffer | null> {
  if (!(await edgeTtsInstalled())) return null;
  const voice = EDGE_VOICES[voiceId] ?? "en-US-AvaNeural";
  const deltaPct = Math.round((speed - 1) * 100);
  const ratePct = `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`;
  const out = path.join(os.tmpdir(), `mjane-tts-${Date.now()}.mp3`);
  try {
    await run("python3", ["-m", "edge_tts", "--voice", voice, `--rate=${ratePct}`, "--text", text.slice(0, 3500), "--write-media", out], { timeout: 60_000 });
    const mp3 = await fs.readFile(out);
    return mp3;
  } catch {
    return null;
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}

async function tryProviders(
  path: string,
  init: (provider: VoiceProvider) => RequestInit,
): Promise<Response | { allFailed: string }> {
  const providers = await listVoiceProviders();
  let lastError = "no audio-capable provider with an API key";
  for (const provider of providers) {
    try {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}${path}`, init(provider));
      if (res.ok) return res;
      lastError = `${provider.baseUrl} -> HTTP ${res.status}`;
    } catch (error: unknown) {
      lastError = `${provider.baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { allFailed: lastError };
}

voiceRouter.post("/transcribe", async (req, res) => {
  try {
    const { audioBase64, mime = "audio/webm" } = req.body as {
      audioBase64?: string;
      mime?: string;
    };
    if (!audioBase64) {
      res.status(400).json({ error: "audioBase64 is required" });
      return;
    }
    const buffer = Buffer.from(audioBase64, "base64");
    const result = await tryProviders("/audio/transcriptions", (provider) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), "speech.webm");
      form.append("model", "whisper-1");
      return { method: "POST", headers: { Authorization: `Bearer ${provider.apiKey}` }, body: form, signal: AbortSignal.timeout(env.requestTimeoutMs) };
    });
    if ("allFailed" in result) {
      res.status(409).json({ error: `Transcription unavailable (${result.allFailed}). Add an OpenAI-compatible key with whisper support in Settings.` });
      return;
    }
    const json = (await result.json()) as { text?: string };
    res.json({ text: json.text ?? "" });
  } catch (error: unknown) {
    res.status(500).json({ error: `Transcription failed: ${error instanceof Error ? error.message : String(error)}` });
  }
});

voiceRouter.post("/speak", async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const voice = typeof req.body?.["voice"] === "string" ? req.body["voice"] : "nova";
    const speed = Math.min(2, Math.max(0.5, Number(req.body?.["speed"] ?? 1) || 1));
    const localMp3 = await speakWithEdgeTts(text.trim(), voice, speed);
    if (localMp3) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(localMp3);
      return;
    }
    const result = await tryProviders("/audio/speech", (provider) => ({
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice, input: text.slice(0, 4000), speed }),
      signal: AbortSignal.timeout(env.requestTimeoutMs),
    }));
    if ("allFailed" in result) {
      res.status(409).json({ error: `AI voice unavailable (${result.allFailed}). Switch to the Browser engine or add an OpenAI key.` });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const reader = result.body?.getReader();
    if (!reader) {
      res.status(502).end();
      return;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error: unknown) {
    res.status(500).json({ error: `TTS failed: ${error instanceof Error ? error.message : String(error)}` });
  }
});
