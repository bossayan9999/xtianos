import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkText, cosine, hashEmbed, keywordScore } from "./memory/embeddings";
import { normalizeContent } from "./providers/openai-compat";
import { ToolRegistry } from "./tools/registry";
import type { ToolContext } from "./types";

const noopCtx = (): ToolContext => ({
  vaultPath: "/tmp",
  workspaceDir: "/tmp",
  conversationId: null,
  emit: () => undefined,
});

describe("embeddings", () => {
  it("hash embedding is normalized and similar texts score higher", () => {
    const a = hashEmbed("docker container crashed on proxmox host");
    const b = hashEmbed("docker container crash proxmox");
    const c = hashEmbed("chocolate cake recipe with frosting");
    assert.equal(Math.round(a.reduce((s, v) => s + v * v, 0) * 1000) / 1000, 1);
    assert.ok(cosine(a, b) > cosine(a, c));
  });

  it("keyword score is fraction of matched query tokens", () => {
    assert.equal(keywordScore("docker stop", "docker stop now"), 1);
    assert.equal(keywordScore("docker kubernetes", "only docker"), 0.5);
    assert.equal(keywordScore("", "anything"), 0);
  });

  it("chunks overlap", () => {
    const text = "x".repeat(2000);
    const chunks = chunkText(text, 900, 120);
    assert.ok(chunks.length >= 2);
  });
});

describe("ToolRegistry", () => {
  it("executes a registered tool and validates args", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echoes",
      scopes: [],
      params: [{ name: "text", type: "string", description: "text", required: true }],
      run: async (args) => `said ${String(args["text"])}`,
    });
    assert.equal(
      await registry.execute("echo", JSON.stringify({ text: "hi" }), noopCtx()),
      "said hi",
    );
    assert.match(await registry.execute("echo", "{}", noopCtx()), /missing required/);
    assert.match(await registry.execute("nope", "{}", noopCtx()), /unknown tool/);
    assert.match(await registry.execute("echo", "not-json", noopCtx()), /not valid JSON/);
  });

  it("catches tool crashes as ERROR strings", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "",
      scopes: [],
      params: [],
      run: async () => {
        throw new Error("kaput");
      },
    });
    assert.match(await registry.execute("boom", "{}", noopCtx()), /kaput/);
  });
});

describe("normalizeContent", () => {
  it("passes through string content", () => {
    assert.equal(normalizeContent({ content: "hello" }), "hello");
  });
  it("joins array-of-parts content", () => {
    assert.equal(
      normalizeContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      "ab",
    );
  });
  it("returns empty for null/undefined content", () => {
    assert.equal(normalizeContent(undefined), "");
    assert.equal(normalizeContent({ content: null }), "");
  });
});
