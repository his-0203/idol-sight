#!/usr/bin/env node
// Usage: node scripts/gen-password-hash.mjs <password>
// Prints `${ITER}$${saltB64}$${hashB64}` matching frontend/functions/lib/hmac.ts.

import { webcrypto as crypto } from "node:crypto";

const ITER = 200_000;

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("usage: node scripts/gen-password-hash.mjs <password>");
    process.exit(2);
  }
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, key, 256,
  );
  process.stdout.write(`${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
