import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyBrainPath, detectRepoInfo, settingBool, settingInt } from "./services/housekeeper";

test("settingBool parses true/false with fallback", () => {
  assert.equal(settingBool("true", false), true);
  assert.equal(settingBool("false", true), false);
  assert.equal(settingBool("nonsense", true), true);
  assert.equal(settingBool("", false), false);
});

test("settingInt parses non-negative integers", () => {
  assert.equal(settingInt("30", 0), 30);
  assert.equal(settingInt("0", 7), 0);
  assert.equal(settingInt("abc", 7), 7);
  assert.equal(settingInt("-5", 7), 7);
});

test("classifyBrainPath keeps already-organized and hidden files", () => {
  assert.equal(classifyBrainPath("BRAIN/Memory/foo.md", "# x").keep, true);
  assert.equal(classifyBrainPath(".hidden.md", "# x").keep, true);
});

test("classifyBrainPath never moves the vault home note", () => {
  assert.equal(classifyBrainPath("Welcome.md", "").keep, true);
});

test("classifyBrainPath routes date-prefixed notes to Sessions", () => {
  const c = classifyBrainPath("2026-08-28-standup.md", "# standup");
  assert.equal(c.keep, false);
  assert.equal(c.to, "BRAIN/Sessions");
});

test("classifyBrainPath routes homelab topics to Homelab", () => {
  const c = classifyBrainPath("proxmox-node.md", "proxmox pve cluster notes");
  assert.equal(c.to, "BRAIN/Homelab");
});

test("classifyBrainPath routes tool/skill notes to Sources", () => {
  const c = classifyBrainPath("mcp-servers.md", "list of mcp integrations");
  assert.equal(c.to, "BRAIN/Sources");
});

test("classifyBrainPath routes people notes to Wiki/People", () => {
  const c = classifyBrainPath("alex-leblanc.md", "Alex Leblanc profile, bio interview notes");
  assert.equal(c.to, "BRAIN/Wiki/People");
});

test("classifyBrainPath defaults misc notes to Memory", () => {
  const c = classifyBrainPath("random-thought.md", "just a stream of consciousness");
  assert.equal(c.to, "BRAIN/Memory");
});

test("detectRepoInfo finds npm test for package.json repos", () => {
  assert.equal(detectRepoInfo("C:/Users/Christian/xtiandOS")?.testCmd, "npm test");
});

test("detectRepoInfo returns null for unsupported dirs", () => {
  assert.equal(detectRepoInfo("C:/this/dir/does/not/exist/xyz"), null);
});