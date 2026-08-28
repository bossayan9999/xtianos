import fs from "node:fs";
import path from "node:path";

import type { ToolContext } from "@xtiand/mjane-core";

import { prisma } from "../lib/db";
import { env } from "../lib/env";

const IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

export interface McpImagePayload {
  base64: string;
  mime: string;
  filename?: string;
}

/**
 * Parse an MCP tool result into an image payload without touching the disk.
 * Recognizes data: URLs, and JSON combos of { mime/base64 } or { filename/data }.
 */
export function parseMcpImagePayload(result: string): McpImagePayload | null {
  if (typeof result !== "string" || result.trim().length === 0) return null;

  const dataUrlMatch = /data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]{24,})/.exec(result);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1];
    if (!IMAGE_MIME[mime]) return null;
    return { base64: dataUrlMatch[2].replace(/\s+/g, ""), mime };
  }

  const mimeHintKeys = ["mimeType", "mime_type", "contentType", "content_type", "mime"];
  const base64Keys = ["image", "data", "base64", "b64_json", "image_base64", "imageData", "encoded"];
  const filenameKeys = ["filename", "file_name", "fileName", "save_to", "image_path", "path"];

  const mimeHint = (() => {
    for (const key of mimeHintKeys) {
      const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(result);
      if (m && IMAGE_MIME[m[1]]) return m[1];
    }
    return null;
  })();

  for (const key of base64Keys) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:data:)?[A-Za-z0-9+/=\\s]{40,})"`).exec(result);
    if (!m) continue;
    const raw = m[1];
    if (raw.startsWith("data:")) {
      const inner = parseMcpImagePayload(raw);
      if (inner) return inner;
      continue;
    }
    // bare base64: only trust it when a mime hint is present
    if (!mimeHint) continue;
    const b64 = raw.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
      return { base64: b64, mime: mimeHint };
    }
  }

  if (mimeHint) {
    for (const key of ["image", "data", "base64"]) {
      const m = new RegExp(`"${key}"\\s*:\\s*"([A-Za-z0-9+/=\\s]+)"`).exec(result);
      if (m) {
        const b64 = m[1].replace(/\s+/g, "");
        if (b64.length > 100 && b64.length % 4 === 0) return { base64: b64, mime: mimeHint };
      }
    }
  }

  return null;
}

/** Resolve a pixel file path (absolute or relative to the workspace) to a payload. */
export function imagePayloadFromPath(
  rawPath: string,
  workspaceDir: string,
): McpImagePayload | null {
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceDir, rawPath);
  const ext = path.extname(candidate).toLowerCase();
  const mime = Object.keys(IMAGE_MIME).find((m) => IMAGE_MIME[m] === ext.slice(1));
  if (!mime) return null;
  let data: Buffer;
  try {
    data = fs.readFileSync(candidate);
  } catch {
    return null;
  }
  if (data.length === 0) return null;
  return {
    base64: data.toString("base64"),
    mime,
    filename: path.basename(candidate),
  };
}

/** Search a tool result for an image file path that actually exists on disk. */
export function findMcpImagePath(result: string, workspaceDir: string): string | null {
  const imageLike =
    /([A-Za-z]:[\\/][^\s"',)]+|(?:\.[\\/])?[^\s"',)]*\.(?:png|jpe?g|webp|gif|bmp))(?=[\s"',)\n]|$)/i;
  const m = imageLike.exec(result);
  if (!m) return null;
  const candidate = m[1];
  if (path.isAbsolute(candidate) || fs.existsSync(path.resolve(workspaceDir, candidate))) {
    return candidate;
  }
  return null;
}

const PATH_RESULT_KEYS = [
  "imagePath",
  "image_path",
  "outputPath",
  "output_path",
  "output_file",
  "outputFile",
  "file_path",
  "save_path",
];

/**
 * Extract an image payload from a tool result: data URLs / base64 JSON first,
 * then file paths (keyed or free-form) that exist on disk.
 */
export function imagePayloadFromResult(result: string, workspaceDir: string): McpImagePayload | null {
  const parsed = parseMcpImagePayload(result);
  if (parsed) return parsed;

  for (const key of PATH_RESULT_KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(result);
    if (m) {
      const payload = imagePayloadFromPath(m[1], workspaceDir);
      if (payload) return payload;
    }
  }

  const found = findMcpImagePath(result, workspaceDir);
  return found ? imagePayloadFromPath(found, workspaceDir) : null;
}

export interface StoredMcpImage {
  id: number;
  filename: string;
  mime: string;
}

/** Persist an extracted MCP image as an artifact and surface it to the chat. */
export async function storeMcpImage(
  image: McpImagePayload,
  ctx: ToolContext,
  resultSnippet = "",
): Promise<StoredMcpImage> {
  const ext = IMAGE_MIME[image.mime] ?? "png";
  const safeName = image.filename
    ? path.basename(String(image.filename)).replace(/\.$/, "")
    : "";
  const base = safeName ? safeName.replace(/\.[a-z0-9]+$/i, "") : `mcp_${Date.now()}`;
  const filename = `${base}.${ext}`;
  const artifact = await prisma.artifact.create({
    data: {
      conversationId: ctx.conversationId,
      kind: "image",
      filename,
      mime: image.mime,
      contentBase64: image.base64,
      textPreview: resultSnippet.slice(0, 2000),
    },
  });
  await fs.promises.writeFile(
    path.join(env.workspaceDir, `${artifact.id}_${filename}`),
    Buffer.from(image.base64, "base64"),
  );
  ctx.emit({
    type: "artifact",
    data: { id: artifact.id, filename, mime: image.mime, kind: "image" },
  });
  return { id: artifact.id, filename, mime: image.mime };
}