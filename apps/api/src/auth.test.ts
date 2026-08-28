import { test } from "node:test";
import assert from "node:assert/strict";

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hashPassword,
  hashToken,
  totpToken,
  verifyPassword,
  verifyTotp,
} from "./lib/auth";
import { validateEmail } from "./routes/auth";

test("scrypt hash/verify round-trip", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("scrypt rejects malformed stored values", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "scrypt$bad"), false);
  assert.equal(verifyPassword("x", "bcrypt$5$6$7$8$9"), false);
  assert.equal(verifyPassword("x", "scrypt$abc$def$ghi$jkl$mno"), false);
});

test("TOTP matches RFC 6238 SHA1 vectors", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  // RFC 6238 appendix B: secret = ASCII "12345678901234567890", 30s window
  assert.equal(totpToken(secret, 59), "287082");
  assert.equal(totpToken(secret, 1111111109), "081804");
  assert.equal(totpToken(secret, 1234567890), "005924");
  assert.equal(totpToken(secret, 2000000000), "279037");
});

test("base32 round-trip and secret shape", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(base32Encode(Buffer.from("hello"))).toString(), "hello");
});

test("verifyTotp accepts current window, rejects garbage", () => {
  const secret = generateTotpSecret();
  const code = totpToken(secret);
  assert.equal(verifyTotp(secret, code), true);
  assert.equal(verifyTotp(secret, "000000"), false);
  assert.equal(verifyTotp(secret, "12345"), false);
  assert.equal(verifyTotp(secret, "abcdef"), false);
});

test("session token hashing is deterministic and one-way-ish", () => {
  const a = hashToken("abc");
  const b = hashToken("abc");
  const c = hashToken("abd");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, "abc");
});

test("validateEmail accepts normal addresses and rejects junk", () => {
  assert.equal(validateEmail("admin@example.com"), true);
  assert.equal(validateEmail("someone+tag@sub.example.co"), true);
  assert.equal(validateEmail(""), false);
  assert.equal(validateEmail("not-an-email"), false);
  assert.equal(validateEmail("a@b"), false);
  assert.equal(validateEmail("a b@c.d"), false);
});