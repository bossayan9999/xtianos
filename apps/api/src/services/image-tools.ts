import path from "node:path";
import fs from "node:fs/promises";
import type { ToolDef } from "@xtiand/mjane-core";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { generateImage, loadImageConfig, persistImage, type GeneratedImage } from "./image-service";

export interface ImageToolOptions {
  enabled: boolean;
}

/**
 * The image_generate tool — real photorealistic image generation via pluggable
 * backends (OpenAI DALL·E, Flux, Stable Diffusion, NVIDIA NIM). Saves the result
 * to the artifacts library and returns the artifact reference so agents/MCP can
 * display or use it downstream.
 */
export function imageTool(opts: ImageToolOptions): ToolDef | null {
  if (!opts.enabled) return null;

  return {
    name: "image_generate",
    description:
      "Generate a photorealistic or artistic image from a detailed text prompt using the configured image backend (OpenAI DALL·E / gpt-image, Flux, Stable Diffusion, or NVIDIA NIM). Use this ONLY for real raster images (photos, renders, paintings). For diagrams/charts/precise text layouts use SVG instead. Provide an extremely detailed prompt: subject, style, lighting, mood, colors, composition, and aspect. The image is saved to the artifacts library.",
    scopes: ["read", "fs-write"],
    params: [
      { name: "prompt", type: "string", description: "Detailed image description", required: true },
      {
        name: "size",
        type: "string",
        description: "Size, e.g. 1024x1024, 1792x1024 (landscape), 1024x1792 (portrait). Default 1024x1024.",
        required: false,
      },
      {
        name: "quality",
        type: "string",
        description: "Quality: low|medium|high|auto (OpenAI).",
        required: false,
      },
      {
        name: "style",
        type: "string",
        description: "Style preset: vivid|natural (OpenAI).",
        required: false,
      },
    ],
    run: async (args: Record<string, unknown>, ctx: import("@xtiand/mjane-core").ToolContext) => {
      const prompt = String(args["prompt"] ?? "").trim();
      if (!prompt) return "ERROR: prompt is required";
      const size = typeof args["size"] === "string" ? args["size"] : "1024x1024";
      const quality = typeof args["quality"] === "string" ? args["quality"] : "auto";
      const style = typeof args["style"] === "string" ? args["style"] : "vivid";

      await audit("tool:image_generate", prompt.slice(0, 300));

      const cfg = await loadImageConfig();
      if (!cfg.apiKey) {
        return "ERROR: image generation is not configured. Set an API key for the image provider (Settings → Image generation).";
      }

      let image: GeneratedImage;
      try {
        image = await generateImage(cfg, { prompt, size, quality, style });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        return `ERROR image generation failed: ${reason} — the raster image backend is unavailable right now. To still give the user a visual, create a self-contained inline SVG with artifact_save (filename ending .svg, mime "image/svg+xml", kind image) and end your final message with a line exactly like ARTIFACT:<id>. Do not leave the user without an image.`;
      }

      const saved = await persistImage(cfg, image, prompt, ctx.conversationId ?? null);
      ctx.emit({
        type: "artifact",
        data: { id: saved.id, filename: saved.filename, mime: image.mime, kind: "image" },
      });
      return JSON.stringify({
        ok: true,
        artifactId: saved.id,
        filename: saved.filename,
        provider: cfg.provider,
        model: cfg.model,
        size,
        format: image.format,
        artifactRef: `ARTIFACT:${saved.id}`,
      });
    },
  };
}

/**
 * image_read — lets a vision-capable model actually SEE an image from the
 * artifacts library (or a workspace file). Loads the bytes, converts to a
 * data URL, and attaches it to the model's next request via ctx.attachImage.
 */
export function imageReadTool(): ToolDef {
  return {
    name: "image_read",
    description:
      "View/read an image so the model can see it. Provide an artifact id (from image_generate or artifact_save) or a workspace file path. The image is attached to your next model request as vision input. Use this to inspect a generated image before describing/editing it.",
    scopes: ["read"],
    params: [
      { name: "artifactId", type: "number", description: "Artifact id to view", required: false },
      { name: "path", type: "string", description: "Workspace file path (relative to workspace dir) to view", required: false },
    ],
    run: async (args: Record<string, unknown>, ctx: import("@xtiand/mjane-core").ToolContext) => {
      const artifactId = typeof args["artifactId"] === "number" ? args["artifactId"] : null;
      let mime = "";
      let contentBase64: string | null = null;

      if (artifactId !== null) {
        const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } }).catch(() => null);
        if (!artifact) return `ERROR: artifact #${artifactId} not found`;
        if (!artifact.contentBase64) return `ERROR: artifact #${artifactId} has no stored image bytes`;
        mime = artifact.mime;
        contentBase64 = artifact.contentBase64;
      } else {
        const p = String(args["path"] ?? "").trim();
        if (!p) return "ERROR: provide artifactId or path";
        const full = ctx.workspaceDir ? path.resolve(ctx.workspaceDir, p) : path.resolve(p);
        // Path-traversal guard: reads must stay inside the workspace.
        if (ctx.workspaceDir && !(full === path.resolve(ctx.workspaceDir) || full.startsWith(path.resolve(ctx.workspaceDir) + path.sep))) {
          return `ERROR: path ${p} resolves outside the workspace`;
        }
        const data = await fs.readFile(full).catch(() => null);
        if (!data) return `ERROR: could not read ${p}`;
        const ext = p.split(".").pop()?.toLowerCase() ?? "";
        mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
        contentBase64 = data.toString("base64");
      }

      await audit("tool:image_read", `${artifactId !== null ? `artifact#${artifactId}` : "file"} (${mime})`);

      if (!ctx.attachImage) {
        return `OK image ready (${mime}, base64 ${contentBase64.length} chars) — but this runtime cannot return images to the model.`;
      }
      ctx.attachImage(`data:${mime};base64,${contentBase64}`);
      return `OK: attached image (${mime}) — inspect it now and describe what you see.`;
    },
  };
}

