#!/usr/bin/env node
// Smoke test: encoded output must round-trip through the same PBKDF2 params.

import { webcrypto as crypto } from "node:crypto";
import { execFileSync } from "node:child_process";

async function pbkdf2(pw, salt, iter) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, k, 256,
  );
  return new Uint8Array(bits);
}

function b64decode(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}

const out = execFileSync("node", ["scripts/gen-password-hash.mjs", "Virtual2026"]).toString().trim();
const [iterStr, saltB64, hashB64] = out.split("$");
const iter = parseInt(iterStr, 10);
if (iter !== 200_000) { console.error("iter mismatch"); process.exit(1); }

const got = await pbkdf2("Virtual2026", b64decode(saltB64), iter);
const expected = b64decode(hashB64);
if (Buffer.compare(got, expected) !== 0) { console.error("hash mismatch"); process.exit(1); }

console.log("OK");
