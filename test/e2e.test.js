/**
 * End-to-end CLI tests for outagekit (run with `npm test`).
 * The CLI is spawned as a subprocess with OUTAGEKIT_NOW pinned to
 * 2026-11-14 and OUTAGEKIT_OFFLINE=1, so fixture verdicts are
 * deterministic on any machine, online or offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const EXAMPLES = join(ROOT, "examples");
const ENV = { ...process.env, OUTAGEKIT_NOW: "2026-11-14", OUTAGEKIT_OFFLINE: "1" };

function run(args, env = ENV) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8", env });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "outagekit-e2e-"));
}

test("init -> audit -> check golden path, and init refuses to overwrite", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = run(["init", "--dir", dir]);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(join(dir, "outagekit.json")));
  assert.ok(existsSync(join(dir, "runbooks", "microsoft-365.md")));
  assert.ok(existsSync(join(dir, "templates", "staff-announcement.md")));
  const audit = run(["audit", dir]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /verdict: READY/);
  const check = run(["check", dir]);
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /check: READY \(exit 0\)/);
  const again = run(["init", "--dir", dir]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /refusing to overwrite/);
});

test("audit acme-ops: GAPS with the locked finding counts; check exits 1", () => {
  const audit = run(["audit", join(EXAMPLES, "acme-ops"), "--format", "json"]);
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.verdict, "GAPS");
  assert.deepEqual(result.summary, { critical: 0, high: 8, warn: 3, unchecked: 1, skipped: 0 });
  const c5 = result.checks.find((c) => c.id === "C5");
  assert.equal(c5.findings.length, 3);
  assert.ok(c5.findings.every((f) => f.file === "runbooks/microsoft-365.md" && f.line && f.evidence));
  assert.equal(result.checks.find((c) => c.id === "C4").result, "FAIL");
  assert.equal(result.checks.find((c) => c.id === "C8").findings.length, 3);
  const check = run(["check", join(EXAMPLES, "acme-ops")]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /check: GAPS \(exit 1\)/);
});

test("audit ready-ops: READY; check exits 0", () => {
  const audit = run(["audit", join(EXAMPLES, "ready-ops"), "--format", "json"]);
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.summary, { critical: 0, high: 0, warn: 0, unchecked: 1, skipped: 0 });
  assert.ok(result.checks.every((c) => c.result === "PASS" || c.result === "UNCHECKED"));
  const check = run(["check", join(EXAMPLES, "ready-ops")]);
  assert.equal(check.status, 0);
});

test("explain --check C5 prints the rule, the file:line evidence and the fix", () => {
  const ex = run(["explain", join(EXAMPLES, "acme-ops"), "--check", "C5"]);
  assert.equal(ex.status, 0, ex.stderr);
  assert.match(ex.stdout, /explain C5 - NO-LOCAL-FIX/);
  assert.match(ex.stdout, /runbooks\/microsoft-365\.md:12/);
  assert.match(ex.stdout, /how to fix:/);
  const unknown = run(["explain", join(EXAMPLES, "acme-ops"), "--check", "C99"]);
  assert.equal(unknown.status, 0);
  assert.match(unknown.stdout, /unknown check: C99/);
});

test("diff: ready baseline vs acme-ops exits 1 (NEW HIGH); same-vs-same exits 0", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = run(["audit", join(EXAMPLES, "ready-ops"), "--format", "json"]);
  const readyPath = join(dir, "ready.json");
  writeFileSync(readyPath, ready.stdout);
  const acme = run(["audit", join(EXAMPLES, "acme-ops"), "--format", "json"]);
  const acmePath = join(dir, "acme.json");
  writeFileSync(acmePath, acme.stdout);
  const worse = run(["diff", "--baseline", readyPath, join(EXAMPLES, "acme-ops")]);
  assert.equal(worse.status, 1, worse.stdout);
  assert.match(worse.stdout, /NEW findings \(11\)/);
  const same = run(["diff", "--baseline", acmePath, join(EXAMPLES, "acme-ops")]);
  assert.equal(same.status, 0, same.stdout);
  assert.match(same.stdout, /NEW findings \(0\)/);
  assert.match(same.stdout, /STILL-OPEN findings \(11\)/);
  const bad = run(["diff", "--baseline", join(dir, "nope.json"), join(EXAMPLES, "acme-ops")]);
  assert.equal(bad.status, 2);
});

test("config errors exit 2: missing manifest, missing dir, bad JSON", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(["audit", dir]).status, 2);
  assert.equal(run(["audit", join(dir, "no-such-dir")]).status, 2);
  writeFileSync(join(dir, "outagekit.json"), "{not json");
  const bad = run(["audit", dir]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not valid JSON/);
});

test("--max-warn fails a READY result when WARNs exceed N", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(EXAMPLES, "ready-ops"), dir, { recursive: true });
  const cfgPath = join(dir, "outagekit.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.lastDrill = "2026-05-01";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  assert.equal(run(["check", dir]).status, 0);
  const gated = run(["check", dir, "--max-warn", "0"]);
  assert.equal(gated.status, 1);
  assert.match(gated.stdout, /exceed --max-warn 0/);
});

test("threshold overrides in the manifest change the verdict inputs", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(EXAMPLES, "acme-ops"), dir, { recursive: true });
  const cfgPath = join(dir, "outagekit.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.thresholds = { fallbackTestMaxDays: 300, drillMaxDays: 300 };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const audit = run(["audit", dir, "--format", "json"]);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.checks.find((c) => c.id === "C6").result, "PASS");
  assert.equal(result.checks.find((c) => c.id === "C10").result, "PASS");
  assert.equal(result.verdict, "GAPS"); // HIGH findings remain
});

test("privacy: phone/email in escalation is a config error; evidence redacts contacts", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(EXAMPLES, "ready-ops"), dir, { recursive: true });
  const cfgPath = join(dir, "outagekit.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.escalation.primary.channel = "+1-555-123-4567";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const bad = run(["audit", dir]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /phone numbers and email addresses/);

  // Evidence line carrying contact data must come out redacted.
  const dir2 = tmp();
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  cpSync(join(EXAMPLES, "ready-ops"), dir2, { recursive: true });
  mkdirSync(join(dir2, "runbooks"), { recursive: true });
  writeFileSync(
    join(dir2, "runbooks", "microsoft-365.md"),
    "# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n\nReinstall Outlook, then mail admin@example.com or call 555-123-4567.\n",
  );
  const cfg2 = JSON.parse(readFileSync(join(dir2, "outagekit.json"), "utf8"));
  cfg2.vendors[0].runbook = "runbooks/microsoft-365.md";
  writeFileSync(join(dir2, "outagekit.json"), JSON.stringify(cfg2, null, 2));
  const out = run(["audit", dir2, "--format", "json"]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes("admin@example.com"), "email leaked into JSON output");
  assert.ok(!out.stdout.includes("555-123-4567"), "phone leaked into JSON output");
  assert.ok(out.stdout.includes("[redacted]"), "redaction marker missing");
});
