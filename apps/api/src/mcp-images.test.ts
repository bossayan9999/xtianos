import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findMcpImagePath,
  imagePayloadFromPath,
  imagePayloadFromResult,
  parseMcpImagePayload,
} from "./services/mcp-images";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYAAAAAMAASsJTYQA";

test("parseMcpImagePayload extracts data URLs", () => {
  const out = parseMcpImagePayload(
    `Generated. data:image/png;base64,${PNG}`,
  );
  assert.equal(out?.mime, "image/png");
  assert.equal(out?.base64, PNG);
});

test("parseMcpImagePayload extracts JSON {mimeType, image} combos", () => {
  const b64 = Buffer.alloc(30, 0xff).toString("base64");
  const out = parseMcpImagePayload(
    `{"mimeType":"image/jpeg","image":"${b64}","ok":true}`,
  );
  assert.equal(out?.mime, "image/jpeg");
  assert.equal(out?.base64, b64);
});

test("parseMcpImagePayload extracts JSON {contentType, b64_json}", () => {
  const out = parseMcpImagePayload(
    `{"contentType":"image/webp","b64_json":"${PNG}"}`,
  );
  assert.equal(out?.mime, "image/webp");
  assert.equal(out?.base64, PNG);
});

test("parseMcpImagePayload rejects bare base64 without a mime hint", () => {
  assert.equal(parseMcpImagePayload(`{"data":"${PNG}"}`), null);
});

test("parseMcpImagePayload rejects non-image or tiny payloads", () => {
  assert.equal(parseMcpImagePayload("data:application/pdf;base64,JVBERi0xLjQK"), null);
  assert.equal(parseMcpImagePayload("data:image/png;base64,TUlNR"), null);
});

test("imagePayloadFromPath reads a real image file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xos-mcp-test-"));
  const file = path.join(dir, "shot.png");
  fs.writeFileSync(file, Buffer.from(PNG, "base64"));
  try {
    const out = imagePayloadFromPath(file, os.tmpdir());
    assert.equal(out?.mime, "image/png");
    assert.equal(out?.filename, "shot.png");
    assert.equal(out?.base64, PNG);
    assert.equal(imagePayloadFromPath(path.join(dir, "nope.svg"), dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findMcpImagePath resolves relative paths and ignores text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xos-mcp-test-"));
  fs.writeFileSync(path.join(dir, "out.webp"), "1234");
  try {
    assert.equal(findMcpImagePath("no path here at all", dir), null);
    assert.equal(findMcpImagePath("saved to out.webp", dir), "out.webp");
    assert.equal(findMcpImagePath("missing.png", dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imagePayloadFromResult reads files returned as imagePath keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xos-mcp-test-"));
  const file = path.join(dir, "gen.webp");
  fs.writeFileSync(file, Buffer.from("1234"));
  try {
    const out = imagePayloadFromResult(
      `{"imagePath":"${file.replace(/\\/g, "/")}","mimeType":"image/webp"}`,
      dir,
    );
    assert.equal(out?.mime, "image/webp");
    assert.equal(out?.base64, Buffer.from("1234").toString("base64"));
    assert.equal(imagePayloadFromResult(`{"imagePath":"${path.join(dir, "missing.png")}"}`, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});