// The build monitor's pure logic, checked without a network call or a browser.
//
//   node build.check.mjs
//
// What is worth pinning: the two build-id formats that are both still in the real history, and
// the rules about what counts as a CHANGE — which is the thing that fires a notification, so a
// wrong answer is either a missed deploy or an alert at 3am for nothing.
//
// The stamps are parsed as local time, so the zone is pinned; without it the expected hours only
// hold on a machine at +03:00.
process.env.TZ = "Etc/GMT-3"; // POSIX sign convention: GMT-3 IS UTC+3
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "deck-bm-"));
const out = join(dir, "build.mjs");
await build({
  entryPoints: [join(import.meta.dirname, "src/build.ts")],
  outfile: out, format: "esm", bundle: false,
});
const { decode, fold, emptyWatch, stampToMillis, ago } = await import(`file://${out}`);
rmSync(dir, { recursive: true, force: true });

// ---- decode: both shapes are real, both are in the history ---------------------------------
const dashed = decode("dev-b1215f8-20260804121329");
assert.equal(dashed.label, "dev");
assert.equal(dashed.commit, "b1215f8");
assert.equal(new Date(dashed.builtAt).getHours(), 12, "the stamp is local time, not UTC");

const dotted = decode("1.5.10.7b3028d.20260619113412");
assert.equal(dotted.label, "v1.5.10");
assert.equal(dotted.commit, "7b3028d");
assert.equal(new Date(dotted.builtAt).getHours(), 11);

// A branch containing dashes keeps them: only the last two segments are commit and stamp.
const branchy = decode("release-2-x-a1b2c3d-20260804121329");
assert.equal(branchy.label, "release-2-x");
assert.equal(branchy.commit, "a1b2c3d");

// Anything else is null rather than a guess — a wrong commit hash is worse than none.
assert.equal(decode(""), null);
assert.equal(decode("garbage"), null);
assert.equal(decode("only-two"), null);
// A shape that parses but whose stamp does not: the parts are still useful.
const noStamp = decode("dev-abc1234-notadate");
assert.equal(noStamp.commit, "abc1234");
assert.equal(noStamp.builtAt, null);

assert.equal(stampToMillis("2026080412"), null, "a short stamp is not a date");
assert.equal(stampToMillis(""), null);

// ---- fold: what counts as a change ----------------------------------------------------------
const t0 = Date.parse("2026-09-12T10:00:00+03:00");

// First ever poll: recorded in history, but NOT announced — there is nothing to have changed from.
let w = emptyWatch("dev");
let r = fold(w, "dev-aaa1111-20260901120000", t0, 200);
assert.equal(r.changed, false, "the first build seen is not a change");
assert.equal(r.next.history.length, 1);
assert.equal(r.next.buildId, "dev-aaa1111-20260901120000");
assert.equal(r.next.polls, 1);

// Same build again: no history entry, no announcement — this is the common case, every minute.
r = fold(r.next, "dev-aaa1111-20260901120000", t0 + 60000, 200);
assert.equal(r.changed, false);
assert.equal(r.next.history.length, 1, "an unchanged build must not be recorded again");
assert.equal(r.next.polls, 2);

// A genuinely new build: recorded AND announced.
r = fold(r.next, "dev-bbb2222-20260902120000", t0 + 120000, 200);
assert.equal(r.changed, true, "a new build is a change");
assert.equal(r.next.history.length, 2);
assert.equal(r.next.history[1].seenAt, t0 + 120000);

// A failed poll: the error is recorded, the build is NOT cleared, and nothing is announced.
r = fold(r.next, "", t0 + 180000, 0, "fetch failed");
assert.equal(r.changed, false, "a server going down is not a deploy");
assert.equal(r.next.buildId, "dev-bbb2222-20260902120000", "a failure must not clear the build");
assert.equal(r.next.lastError, "fetch failed");
assert.equal(r.next.history.length, 2);
assert.equal(r.next.polls, 4, "a failed poll still counts as a poll");

// Back up, same build as before the outage: not a change.
r = fold(r.next, "dev-bbb2222-20260902120000", t0 + 240000, 200);
assert.equal(r.changed, false, "recovering is not a deploy");
assert.equal(r.next.history.length, 2);

// ---- restart: history is known, state is empty ----------------------------------------------
// Deck restarts with history loaded but no in-memory build. The first poll matches something
// already recorded, so it must not fire a notification for a deploy that happened last week.
const restarted = { ...emptyWatch("dev"), history: [
  { buildId: "dev-aaa1111-20260901120000", seenAt: t0 },
  { buildId: "dev-bbb2222-20260902120000", seenAt: t0 + 120000 },
] };
r = fold(restarted, "dev-bbb2222-20260902120000", t0 + 999999, 200);
assert.equal(r.changed, false, "catching up after a restart is not a change");
assert.equal(r.next.history.length, 2, "a known build is not recorded twice");

// But a build deployed WHILE Deck was closed is new, and is recorded — just not announced,
// since there was no previous state to change from.
r = fold(restarted, "dev-ccc3333-20260903120000", t0 + 999999, 200);
assert.equal(r.next.history.length, 3, "a build seen while away is still recorded");
assert.equal(r.changed, false, "with no prior build in memory there is nothing to announce");

// ---- ago -------------------------------------------------------------------------------------
const now = Date.parse("2026-09-12T12:00:00+03:00");
assert.equal(ago(now - 10_000, now), "just now");
assert.equal(ago(now - 300_000, now), "5m ago");
assert.equal(ago(now - 7_200_000, now), "2h ago");
assert.equal(ago(now - 3 * 86_400_000, now), "3d ago");
assert.equal(ago(now + 60_000, now), "just now", "a clock skew into the future must not go negative");

console.log("buildmon: all checks passed");
