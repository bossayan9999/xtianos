import fs from "node:fs/promises";
import path from "node:path";

import { prisma } from "../lib/db";
import { env } from "../lib/env";

/** Generation can be slow (Flux/NIM up to ~3 min); cap it to fail gracefully. */
const GENERATION_TIMEOUT_MS = 240_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pluggable image-generation backends.
 *   - openai        : OpenAI Images API (DALL·E / gpt-image)  POST /v1/images/generations
 *   - flux          : Flux-capable OpenAI-compatible endpoint (Replicate / ComfyUI / BFL gateway)
 *   - stable        : Stable Diffusion via OpenAI-compatible endpoint (Stability / ComfyUI / self-host)
 *   - nvidia        : NVIDIA NIM image-generation endpoint
 *
 * Config lives in the DB `Setting` key `imageConfig` as JSON:
 *   { "provider": "openai|flux|stable|nvidia",
 *     "apiKey": "...", "model": "...", "baseUrl": "..." }
 * With env fallbacks: IMAGE_PROVIDER, IMAGE_API_KEY, IMAGE_MODEL, IMAGE_BASE_URL.
 */

export type ImageProvider = "openai" | "flux" | "stable" | "nvidia";

export interface ImageConfig {
  provider: ImageProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const DEFAULTS: Record<ImageProvider, { model: string; baseUrl: string }> = {
  openai: { model: "gpt-image-1", baseUrl: "https://api.openai.com/v1" },
  flux: { model: "flux-1-schnell", baseUrl: "https://api.replicate.com/v1" },
  stable: { model: "stable-diffusion-xl-1024-v1-0", baseUrl: "https://api.stability.ai/v2beta" },
  nvidia: { model: "black-forest-labs/flux.1-schnell", baseUrl: "https://ai.api.nvidia.com/v1/genai" },
};

function normalizeKey(key: string): string {
  return key.replace(/^Bearer\s+/i, "").trim();
}

export async function loadImageConfig(): Promise<ImageConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "imageConfig" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<ImageConfig>;
      const provider = (parsed.provider ?? "openai") as ImageProvider;
      const d = DEFAULTS[provider];
      const model = (parsed.model || process.env["IMAGE_MODEL"] || "").trim();
      const baseUrl = (parsed.baseUrl || process.env["IMAGE_BASE_URL"] || "").trim();
      return {
        provider,
        apiKey: normalizeKey(parsed.apiKey ?? process.env["IMAGE_API_KEY"] ?? ""),
        model: model || d.model,
        baseUrl: baseUrl || d.baseUrl,
      };
    }
  } catch {
    /* fall through to env defaults */
  }
  const provider = (process.env["IMAGE_PROVIDER"] ?? "openai") as ImageProvider;
  const d = DEFAULTS[provider] ?? DEFAULTS.openai;
  return {
    provider,
    apiKey: normalizeKey(process.env["IMAGE_API_KEY"] ?? ""),
    model: process.env["IMAGE_MODEL"] ?? d.model,
    baseUrl: process.env["IMAGE_BASE_URL"] ?? d.baseUrl,
  };
}

export async function saveImageConfig(cfg: ImageConfig): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "imageConfig" },
    update: { value: JSON.stringify(cfg) },
    create: { key: "imageConfig", value: JSON.stringify(cfg) },
  });
}

/** Normalized success object returned by every backend. */
export interface GeneratedImage {
  mime: string; // e.g. image/png
  base64: string;
  format: string; // png | jpeg | webp
}

function assertConfig(cfg: ImageConfig): void {
  if (!cfg.apiKey) throw new Error(`image provider "${cfg.provider}" has no API key configured`);
}

async function generateOpenAI(cfg: ImageConfig, params: {
  prompt: string;
  size: string;
  quality: string;
  style: string;
}): Promise<GeneratedImage> {
  assertConfig(cfg);
  const res = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      prompt: params.prompt,
      n: 1,
      size: params.size,
      quality: params.quality,
      style: params.style,
      response_format: "b64_json",
    }),
  });
  if (!res.ok) throw new Error(`openai image failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (!item) throw new Error("openai returned no image data");
  if (item.b64_json) return { mime: "image/png", base64: item.b64_json, format: "png" };
  if (item.url) return bufferFromUrl(item.url, cfg);
  throw new Error("openai image: no usable payload");
}

async function generateOpenAICompat(cfg: ImageConfig, params: {
  prompt: string;
}): Promise<GeneratedImage> {
  // Generic OpenAI-compatible image endpoint (covers many Flux / SD gateways
  // that expose /images/generations).
  assertConfig(cfg);
  const res = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, prompt: params.prompt, n: 1, response_format: "b64_json" }),
  });
  if (!res.ok) throw new Error(`image failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (!item) throw new Error("image endpoint returned no data");
  if (item.b64_json) return { mime: "image/png", base64: item.b64_json, format: "png" };
  if (item.url) return bufferFromUrl(item.url, cfg);
  throw new Error("image endpoint: no usable payload");
}

async function generateStability(cfg: ImageConfig, params: {
  prompt: string;
  size: string;
}): Promise<GeneratedImage> {
  // Stability REST: POST /generation/<model>/text-to-image
  assertConfig(cfg);
  const [width, height] = parseSize(params.size);
  const res = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, "")}/generation/${encodeURIComponent(cfg.model)}/text-to-image`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        text_prompts: [{ text: params.prompt }],
        cfg_scale: 7,
        width,
        height,
        samples: 1,
      }),
    },
  );
  if (!res.ok) throw new Error(`stability image failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { artifacts?: { base64?: string; finishReason?: string }[] };
  const artifact = json.artifacts?.find((a) => a.base64 && a.finishReason === "SUCCESS");
  if (!artifact?.base64) throw new Error("stability returned no image artifact");
  return { mime: "image/png", base64: artifact.base64, format: "png" };
}

async function generateNvidia(cfg: ImageConfig, params: {
  prompt: string;
}): Promise<GeneratedImage> {
  // NVIDIA NIM hosted image generation:
  //   POST https://ai.api.nvidia.com/v1/genai/<publisher>/<model>
  // body: { prompt, width, height }
  // response: { artifacts: [ { base64 } ] }
  // (Some NIMs also expose OpenAI-compatible /v1/images/generations -> data[].b64_json.)
  assertConfig(cfg);
  // Allow the stored model to be a full path (stabilityai/stable-diffusion-xl) or bare slug.
  let modelPath = cfg.model.trim();
  if (!modelPath.includes("/")) modelPath = `nvidia/${modelPath}`;
  const res = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, "")}/${modelPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
    },
    body: JSON.stringify({ prompt: params.prompt, width: 1024, height: 1024 }),
  });
  if (!res.ok) throw new Error(`nvidia image failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as Record<string, unknown>;
  const artifacts = json["artifacts"] as { base64?: string }[] | undefined;
  const data = json["data"] as { b64_json?: string; base64?: string }[] | undefined;
  const artifactBase64 = artifacts?.find((a) => a.base64)?.base64;
  const itemBase64 = data?.[0] && (data[0].b64_json || data[0].base64);
  const b64 = artifactBase64 || itemBase64;
  if (b64) {
    return { mime: "image/png", base64: b64 as string, format: "png" };
  }
  throw new Error("nvidia returned no image data");
}

async function bufferFromUrl(url: string, cfg: ImageConfig): Promise<GeneratedImage> {
  const res = await fetchWithTimeout(url, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`failed to download image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") ?? "image/png";
  const format = mime === "image/jpeg" || mime === "image/jpg" ? "jpeg" : mime === "image/webp" ? "webp" : "png";
  return { mime, base64: buf.toString("base64"), format };
}

export function parseSize(size: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  return [1024, 1024];
}

/** Dispatches to the configured backend. */
export async function generateImage(cfg: ImageConfig, params: {
  prompt: string;
  size: string;
  quality: string;
  style: string;
}): Promise<GeneratedImage> {
  const prompt = params.prompt.trim();
  switch (cfg.provider) {
    case "openai":
      return generateOpenAI(cfg, params);
    case "stable":
      return generateStability(cfg, params);
    case "nvidia":
      return generateNvidia(cfg, params);
    case "flux":
    default:
      // Flux endpoints vary; most expose an OpenAI-compatible /images/generations.
      // For a bare prompt-safe gateway (e.g. some Replicate variants) we still use
      // the compatible path and let the endpoint error if unsupported.
      return generateOpenAICompat(cfg, { prompt });
  }
}

/** Saves a generated image to the artifacts library + workspace, returns artifact id. */
export async function persistImage(cfg: ImageConfig, image: GeneratedImage, prompt: string, conversationId: number | null): Promise<{ id: number; filename: string }> {
  const stamp = Date.now();
  const filename = `gen_${stamp}_${cfg.provider}.${image.format}`;
  const artifact = await prisma.artifact.create({
    data: {
      conversationId,
      kind: "image",
      filename,
      mime: image.mime,
      contentBase64: image.base64,
      textPreview: prompt.slice(0, 500),
    },
  });
  await fs.writeFile(
    path.join(env.workspaceDir, `${artifact.id}_${filename}`),
    Buffer.from(image.base64, "base64"),
  );
  return { id: artifact.id, filename };
}
