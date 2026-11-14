/**
 * Unit tests for outagekit (run with `npm test`).
 * Dates are pinned to 2026-11-14 and the liveness check is stubbed,
 * so results are deterministic on any machine, online or offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditDir,
  computeVerdict,
  diffAudits,
  redactEvidence,
  FORBIDDEN_PHRASES,
} from "../dist/audit.js";
import { validateConfig, contactHasPrivateData } from "../dist/config.js";

const NOW = new Date("2026-11-14T00:00:00Z");
const OFFLINE = async () => "offline";

const GOOD_RUNBOOK = `# Vendor outage runbook - Microsoft 365

Step 1: Check the vendor status page first:
https://status.cloud.microsoft/m365

Step 2: Post the staff announcement on the fallback channel (SMS).
State only the vendor published cause: {{vendor_cause}}.

Step 3: Do not reinstall anything - there is no local fix for a
vendor outage. Our mail timeout window is 48 hours.
`;

const GOOD_TEMPLATE = `# Staff announcement - vendor outage

We are affected by an outage at {{vendor_name}}.
The vendor published cause is: {{vendor_cause}}.
`;

function baseConfig(overrides = {}) {
  return {
    version: 1,
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/microsoft-365.md",
        criticality: "critical",
      },
    ],
    fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-11-10" },
    escalation: {
      primary: { name: "On-call lead", channel: "phone" },
      backup: { name: "Duty manager", channel: "sms" },
    },
    commsTemplate: "templates/staff-announcement.md",
    mailTimeoutHours: 48,
    lastDrill: "2026-10-20",
    ...overrides,
  };
}

function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "outagekit-unit-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function readyFiles(runbook = GOOD_RUNBOOK, template = GOOD_TEMPLATE) {
  return {
    "runbooks/microsoft-365.md": runbook,
    "templates/staff-announcement.md": template,
  };
}

async function audit(files, cfg, opts = {}) {
  const dir = makeDir(files);
  try {
    return await auditDir(dir, validateConfig(cfg), "0.1.0", {
      now: NOW,
      headCheck: OFFLINE,
      ...opts,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function findingsFor(result, id) {
  return result.checks.find((c) => c.id === id).findings;
}

function checkResult(result, id) {
  return result.checks.find((c) => c.id === id).result;
}

// ---- verdict math ----

test("verdict: READY when no HIGH or CRITICAL findings", () => {
  assert.equal(computeVerdict([{ id: "C1", findings: [] }]), "READY");
});

test("verdict: GAPS on HIGH, NOT-READY on CRITICAL, CRITICAL wins", () => {
  const high = { id: "C4", findings: [{ severity: "HIGH" }] };
  const crit = { id: "C1", findings: [{ severity: "CRITICAL" }] };
  const warn = { id: "C6", findings: [{ severity: "WARN" }] };
  assert.equal(computeVerdict([warn]), "READY");
  assert.equal(computeVerdict([warn, high]), "GAPS");
  assert.equal(computeVerdict([high, crit]), "NOT-READY");
});

// ---- C1 ----

test("C1: critical vendor without a status page is CRITICAL (NOT-READY)", async () => {
  const cfg = baseConfig({
    vendors: [{ name: "Microsoft 365", criticality: "critical" }],
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C1"), "FAIL");
  assert.equal(findingsFor(r, "C1")[0].severity, "CRITICAL");
  assert.equal(r.verdict, "NOT-READY");
});

test("C1: important vendor without a status page is WARN only", async () => {
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/microsoft-365.md",
        criticality: "critical",
      },
      { name: "Stripe", criticality: "important" },
    ],
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C1"), "WARN");
  assert.equal(findingsFor(r, "C1")[0].severity, "WARN");
  assert.equal(r.verdict, "READY");
});

// ---- C2 liveness injection ----

test("C2: stubbed liveness ok/fail/offline maps to PASS/WARN/UNCHECKED", async () => {
  const files = readyFiles();
  const ok = await audit(files, baseConfig(), { headCheck: async () => "ok" });
  assert.equal(checkResult(ok, "C2"), "PASS");
  const failed = await audit(files, baseConfig(), { headCheck: async () => "fail" });
  assert.equal(checkResult(failed, "C2"), "WARN");
  assert.equal(findingsFor(failed, "C2")[0].severity, "WARN");
  const off = await audit(files, baseConfig(), { headCheck: async () => "offline" });
  assert.equal(checkResult(off, "C2"), "UNCHECKED");
  assert.equal(off.verdict, "READY");
});

// ---- C4 ----

test("C4: status page URL in the first 40 lines passes, on line 45 fails", async () => {
  const late = ["# Runbook", ...Array(44).fill("filler line"), "https://status.cloud.microsoft/m365"].join("\n");
  const rLate = await audit(readyFiles(late), baseConfig());
  assert.equal(checkResult(rLate, "C4"), "FAIL");
  const rGood = await audit(readyFiles(), baseConfig());
  assert.equal(checkResult(rGood, "C4"), "PASS");
});

// ---- C5 ----

test("C5: every documented phrase is caught with file and line", async () => {
  const lines = FORBIDDEN_PHRASES.map((p) => `Step: ${p} the thing.`);
  const runbook = `# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n\n${lines.join("\n")}\n`;
  const r = await audit(readyFiles(runbook), baseConfig());
  const found = findingsFor(r, "C5").map((f) => f.message);
  for (const p of FORBIDDEN_PHRASES) {
    assert.ok(found.some((m) => m.includes(`"${p}"`)), `phrase missed: ${p}`);
  }
  assert.ok(findingsFor(r, "C5").every((f) => f.file && f.line && f.evidence));
});

test("C5: negated lines (do not / never) are not hits", async () => {
  const runbook = `# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n\nDo not reinstall anything - there is no local fix.\nNever reset the password during a vendor outage.\nDo not change DNS records.\n`;
  const r = await audit(readyFiles(runbook), baseConfig());
  assert.equal(checkResult(r, "C5"), "PASS");
});

test("C5: per-runbook allowlist excuses a documented exception", async () => {
  const runbook = `# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n\nRebuild the status dashboard cache after recovery.\n`;
  const cfg = baseConfig({ allowlist: { "runbooks/microsoft-365.md": ["rebuild"] } });
  const r = await audit(readyFiles(runbook), cfg);
  assert.equal(checkResult(r, "C5"), "PASS");
  const r2 = await audit(readyFiles(runbook), baseConfig());
  assert.equal(checkResult(r2, "C5"), "FAIL");
});

// ---- C6 ----

test("C6: fallback on a listed vendor channel (teams) is HIGH", async () => {
  const cfg = baseConfig({
    fallbackChannel: { type: "teams", name: "Teams channel", lastTested: "2026-11-10" },
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C6"), "FAIL");
  assert.match(findingsFor(r, "C6")[0].message, /depends on listed vendor/);
});

test("C6: stale fallback is WARN, and the threshold is overridable", async () => {
  const cfg = baseConfig({
    fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-04-27" },
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C6"), "WARN");
  assert.match(findingsFor(r, "C6")[0].message, /201 days ago/);
  const r2 = await audit(readyFiles(), baseConfig({
    fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-04-27" },
    thresholds: { fallbackTestMaxDays: 300 },
  }));
  assert.equal(checkResult(r2, "C6"), "PASS");
});

test("C6: missing fallback channel is HIGH", async () => {
  const cfg = baseConfig();
  delete cfg.fallbackChannel;
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C6"), "FAIL");
  assert.equal(findingsFor(r, "C6")[0].severity, "HIGH");
});

// ---- C7 ----

test("C7: same channel or same person fails; different passes", async () => {
  const sameChannel = baseConfig({
    escalation: {
      primary: { name: "On-call lead", channel: "phone" },
      backup: { name: "Duty manager", channel: "phone" },
    },
  });
  assert.equal(checkResult(await audit(readyFiles(), sameChannel), "C7"), "FAIL");
  const samePerson = baseConfig({
    escalation: {
      primary: { name: "On-call lead", channel: "phone" },
      backup: { name: "on-call lead", channel: "sms" },
    },
  });
  assert.equal(checkResult(await audit(readyFiles(), samePerson), "C7"), "FAIL");
  assert.equal(checkResult(await audit(readyFiles(), baseConfig()), "C7"), "PASS");
});

// ---- C8 ----

test("C8: missing placeholder and self-asserted causes are HIGH", async () => {
  const bad = `# Staff announcement\n\nThe outage was caused by a failed upgrade.\nRoot cause is a network fault.\n`;
  const r = await audit(readyFiles(GOOD_RUNBOOK, bad), baseConfig());
  assert.equal(checkResult(r, "C8"), "FAIL");
  const msgs = findingsFor(r, "C8").map((f) => f.message);
  assert.ok(msgs.some((m) => m.includes("{{vendor_cause}}")));
  assert.equal(findingsFor(r, "C8").filter((f) => f.message.includes("asserts a cause")).length, 2);
  assert.equal(checkResult(await audit(readyFiles(), baseConfig()), "C8"), "PASS");
});

// ---- C9 / C10 thresholds ----

test("C9: timeout below the minimum warns; the minimum is overridable", async () => {
  const cfg = baseConfig({ mailTimeoutHours: 12 });
  assert.equal(checkResult(await audit(readyFiles(), cfg), "C9"), "WARN");
  const cfg2 = baseConfig({
    mailTimeoutHours: 12,
    thresholds: { mailTimeoutMinHours: 12 },
  });
  assert.equal(checkResult(await audit(readyFiles(), cfg2), "C9"), "PASS");
});

test("C9: timeout documented in the runbook counts", async () => {
  const cfg = baseConfig();
  delete cfg.mailTimeoutHours;
  const rb = GOOD_RUNBOOK.replace("48 hours", "48 hours");
  assert.equal(checkResult(await audit(readyFiles(rb), cfg), "C9"), "PASS");
  const cfg2 = baseConfig();
  delete cfg2.mailTimeoutHours;
  const rb2 = "# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n";
  assert.equal(checkResult(await audit(readyFiles(rb2), cfg2), "C9"), "WARN");
});

test("C10: stale or missing drill warns; the threshold is overridable", async () => {
  const cfg = baseConfig({ lastDrill: "2026-05-01" });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C10"), "WARN");
  assert.match(findingsFor(r, "C10")[0].message, /197 days ago/);
  const cfg2 = baseConfig({ lastDrill: "2026-05-01", thresholds: { drillMaxDays: 300 } });
  assert.equal(checkResult(await audit(readyFiles(), cfg2), "C10"), "PASS");
});

// ---- contact privacy ----

test("privacy: phone number or email in an escalation contact is rejected at load", () => {
  const phone = baseConfig({
    escalation: {
      primary: { name: "On-call lead", channel: "+1-555-123-4567" },
      backup: { name: "Duty manager", channel: "sms" },
    },
  });
  assert.throws(() => validateConfig(phone), /phone numbers and email addresses/);
  const email = baseConfig({
    escalation: {
      primary: { name: "lead@example.com", channel: "phone" },
      backup: { name: "Duty manager", channel: "sms" },
    },
  });
  assert.throws(() => validateConfig(email), /phone numbers and email addresses/);
  assert.equal(contactHasPrivateData({ name: "On-call lead", channel: "phone" }), false);
  assert.equal(contactHasPrivateData({ name: "Duty manager", channel: "sms" }), false);
  assert.equal(contactHasPrivateData({ name: "Lead", channel: "call 5551234567" }), true);
});

test("privacy: evidence lines redact emails and phone-like digit runs", () => {
  const redacted = redactEvidence("Reinstall Outlook, then mail admin@example.com or call 555-123-4567.");
  assert.ok(!redacted.includes("admin@example.com"), redacted);
  assert.ok(!redacted.includes("555-123-4567"), redacted);
  assert.ok(redacted.includes("[redacted]"), redacted);
  assert.ok(redacted.includes("Reinstall Outlook"), redacted);
});

// ---- diff ----

test("diff: NEW / FIXED / STILL-OPEN are classified by finding key", async () => {
  const bad = await audit(readyFiles(), baseConfig({
    fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-04-27" },
    lastDrill: "2026-05-01",
  }));
  const good = await audit(readyFiles(), baseConfig());
  const d = diffAudits(bad, good);
  assert.equal(d.fixed.length, 2);
  assert.equal(d.added.length, 0);
  assert.equal(d.stillOpen.length, 0);
  const d2 = diffAudits(good, bad);
  assert.equal(d2.added.length, 2);
  assert.equal(d2.fixed.length, 0);
});
