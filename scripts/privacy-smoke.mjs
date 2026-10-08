#!/usr/bin/env node
// privacy-smoke.mjs — asserts no raw address leaks in analytics events.
// spec-003 Task 8: privacy-by-construction proof.
//
// Verifies:
//   1. The Plausible script tag excludes the URL query string (so ?spotlight=<addr>
//      never leaves the browser in the automatic pageview event).
//   2. Both custom deep-link events exist.
//   3. No plausible() call payload contains a raw Flow address (0x...), flowAddress,
//      dapperID, or username.
//   4. The spotlight event's `spotlight` prop is the literal boolean `true`, not the
//      address/ownerId.
//   5. player_id is String(<obj>.playerId) — the numeric id, never a name/address.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fandomHtml = fs.readFileSync(path.join(root, 'fandom.html'), 'utf-8');
const fandomJs = fs.readFileSync(path.join(root, 'fandom.js'), 'utf-8');

let pass = true;
const checks = [];

// --- Check 1: Plausible script excludes the query string ---
const hasExclude =
  !/<script[^>]*src=["'][^"']*plausible[^"']*["'][^>]*>/i.test(fandomHtml) ||
  (/<script[^>]*plausible[^>]*>/i.test(fandomHtml) &&
  (fandomHtml.includes('data-exclude-search') ||
    fandomHtml.includes('data-exclude-querystring')));
checks.push({ name: 'Analytics disabled or script excludes URL query string', pass: hasExclude });

// --- Check 2: Both custom events exist ---
const hasPlayerEvent =
  fandomJs.includes("'deep_link_player'") || fandomJs.includes('"deep_link_player"');
const hasSpotlightEvent =
  fandomJs.includes("'deep_link_spotlight'") || fandomJs.includes('"deep_link_spotlight"');
checks.push({ name: 'deep_link_player event exists', pass: hasPlayerEvent });
checks.push({ name: 'deep_link_spotlight event exists', pass: hasSpotlightEvent });

// --- Check 3: No raw address / dapperID / username / ownerId in any plausible() payload ---
// Capture each `window.plausible(...)` call statement.
const plausibleCalls = fandomJs.match(/window\.plausible\([^;]*?\)\s*;/g) || [];
const addressPattern = /0x[a-fA-F0-9]{10,}|flowAddress|dapperID|username|ownerId/;
const leakingCalls = plausibleCalls.filter((call) => addressPattern.test(call));
checks.push({
  name: 'No raw address / dapperID / username / ownerId in plausible() payloads',
  pass: leakingCalls.length === 0,
  detail: leakingCalls.length ? `LEAK in: ${leakingCalls[0].trim()}` : null,
});

// --- Check 4: spotlight prop is the literal boolean true ---
const spotlightCalls = plausibleCalls.filter((c) => c.includes('deep_link_spotlight'));
const spotlightBooleanOk =
  spotlightCalls.length > 0 &&
  spotlightCalls.every((c) => /spotlight:\s*true\b/.test(c));
checks.push({ name: 'spotlight prop is literal boolean true', pass: spotlightBooleanOk });

// --- Check 5: player_id is String(...) of a .playerId field (the numeric id) ---
// Must be wrapped in String(...) and reference a `.playerId` property. Forbid any
// name/address/username/dapperID source inside the String(...) call.
const playerCalls = plausibleCalls.filter((c) => c.includes('deep_link_player'));
const playerIdOk =
  playerCalls.length > 0 &&
  playerCalls.every((c) => {
    const m = c.match(/player_id:\s*String\(([^)]+)\)/);
    if (!m) return false; // must be wrapped in String(...)
    const inner = m[1].trim();
    if (/name|address|username|dapperID|flowAddress/i.test(inner)) return false;
    return /\.playerId\b/.test(inner);
  });
checks.push({ name: 'player_id is String(<obj>.playerId) — numeric id only', pass: playerIdOk });

// --- Report ---
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
  if (!c.pass && c.detail) console.log(`    ${c.detail}`);
  if (!c.pass) pass = false;
}
console.log(pass ? '\nPRIVACY SMOKE: PASS' : '\nPRIVACY SMOKE: FAIL');
process.exit(pass ? 0 : 1);
