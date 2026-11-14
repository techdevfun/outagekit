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
  isSkippedFile,
  isValidIsoDate,
  FORBIDDEN_PHRASES,
} from "../dist/audit.js";
import { validateConfig, contactHasPrivateData } from "../dist/config.js";
import { renderTable } from "../dist/report.js";

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
  const late = [
    "# Runbook",
    ...Array(44).fill("filler line"),
    "https://status.cloud.microsoft/m365",
  ].join("\n");
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
    assert.ok(
      found.some((m) => m.includes(`"${p}"`)),
      `phrase missed: ${p}`,
    );
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
  const r2 = await audit(
    readyFiles(),
    baseConfig({
      fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-04-27" },
      thresholds: { fallbackTestMaxDays: 300 },
    }),
  );
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

test("C9: timeout documented in the runbook counts (and a short one warns)", async () => {
  const cfg = baseConfig();
  delete cfg.mailTimeoutHours;
  // GOOD_RUNBOOK documents a 48h window, above the 24h minimum.
  assert.equal(checkResult(await audit(readyFiles(), cfg), "C9"), "PASS");
  // The same runbook with a 12h window is below the minimum: the
  // runbook-documented path must actually read the number.
  const rb12 = GOOD_RUNBOOK.replace("48 hours", "12 hours");
  assert.notEqual(rb12, GOOD_RUNBOOK);
  assert.equal(checkResult(await audit(readyFiles(rb12), cfg), "C9"), "WARN");
  const cfg2 = baseConfig();
  delete cfg2.mailTimeoutHours;
  const rb2 =
    "# Runbook\n\nStep 1: Check the vendor status page first:\nhttps://status.cloud.microsoft/m365\n";
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
  const redacted = redactEvidence(
    "Reinstall Outlook, then mail admin@example.com or call 555-123-4567.",
  );
  assert.ok(!redacted.includes("admin@example.com"), redacted);
  assert.ok(!redacted.includes("555-123-4567"), redacted);
  assert.ok(redacted.includes("[redacted]"), redacted);
  assert.ok(redacted.includes("Reinstall Outlook"), redacted);
});

// ---- diff ----

test("diff: NEW / FIXED / STILL-OPEN are classified by finding key", async () => {
  const bad = await audit(
    readyFiles(),
    baseConfig({
      fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-04-27" },
      lastDrill: "2026-05-01",
    }),
  );
  const good = await audit(readyFiles(), baseConfig());
  const d = diffAudits(bad, good);
  assert.equal(d.fixed.length, 2);
  assert.equal(d.added.length, 0);
  assert.equal(d.stillOpen.length, 0);
  const d2 = diffAudits(good, bad);
  assert.equal(d2.added.length, 2);
  assert.equal(d2.fixed.length, 0);
});

// ---- C3 (missing runbook + shared-runbook fallback) ----

test("C3: missing runbook for a critical vendor is CRITICAL (NOT-READY)", async () => {
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/no-such-runbook.md",
        criticality: "critical",
      },
    ],
  });
  // A runbook file exists, but under a name no candidate resolves
  // to: explicit path missing, slug path missing, no shared file.
  const r = await audit(
    {
      "runbooks/other-vendor.md": GOOD_RUNBOOK,
      "templates/staff-announcement.md": GOOD_TEMPLATE,
    },
    cfg,
  );
  assert.equal(checkResult(r, "C3"), "FAIL");
  assert.equal(findingsFor(r, "C3")[0].severity, "CRITICAL");
  assert.match(findingsFor(r, "C3")[0].message, /no runbook found/);
  assert.equal(r.verdict, "NOT-READY");
});

test("C3: one shared runbook naming every critical vendor passes", async () => {
  const shared = `# Vendor outage runbook (shared)

This runbook covers our critical vendors: Microsoft 365 and GitHub.

## Step 1 - Check the vendor status page first

- Microsoft 365: https://status.cloud.microsoft/m365
- GitHub: https://status.github.com

## Step 2 - Do not try a local fix

Do not reinstall anything - there is no local fix for a vendor
outage. Our mail timeout window is 48 hours.
`;
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        criticality: "critical",
      },
      {
        name: "GitHub",
        statusPageUrl: "https://status.github.com",
        criticality: "critical",
      },
    ],
  });
  const files = {
    "runbooks/vendor-outage-runbook.md": shared,
    "templates/staff-announcement.md": GOOD_TEMPLATE,
  };
  const r = await audit(files, cfg);
  assert.equal(checkResult(r, "C3"), "PASS");
  assert.equal(checkResult(r, "C4"), "PASS");
  assert.equal(checkResult(r, "C5"), "PASS");
  assert.equal(r.verdict, "READY");
});

test("C3: shared runbook that does not name the vendor does not count", async () => {
  const shared = `# Vendor outage runbook (shared)

This runbook covers our critical vendor: Microsoft 365.

## Step 1 - Check the vendor status page first

- Microsoft 365: https://status.cloud.microsoft/m365
`;
  const cfg = baseConfig({
    vendors: [
      {
        name: "Acme Cloud",
        statusPageUrl: "https://status.acme.example",
        criticality: "critical",
      },
    ],
  });
  const files = {
    "runbooks/vendor-outage-runbook.md": shared,
    "templates/staff-announcement.md": GOOD_TEMPLATE,
  };
  const r = await audit(files, cfg);
  assert.equal(checkResult(r, "C3"), "FAIL");
  assert.equal(findingsFor(r, "C3")[0].severity, "CRITICAL");
  assert.equal(r.verdict, "NOT-READY");
});

test("C3: a runbook path matching a secret-file pattern is never read", async () => {
  assert.equal(isSkippedFile("runbooks/secret-notes.md"), true);
  assert.equal(isSkippedFile("runbooks/.env"), true);
  assert.equal(isSkippedFile("runbooks/backup.pem"), true);
  assert.equal(isSkippedFile("runbooks/microsoft-365.md"), false);
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/secret-notes.md",
        criticality: "critical",
      },
    ],
  });
  const files = {
    "runbooks/secret-notes.md": GOOD_RUNBOOK,
    "templates/staff-announcement.md": GOOD_TEMPLATE,
  };
  const r = await audit(files, cfg);
  assert.equal(checkResult(r, "C3"), "FAIL");
  assert.equal(findingsFor(r, "C3")[0].severity, "CRITICAL");
});

// ---- C4 boundary + SKIPPED ----

test("C4: status page URL on line 40 passes, on line 41 fails", async () => {
  const at40 = [
    "# Runbook",
    ...Array(38).fill("filler line"),
    "https://status.cloud.microsoft/m365",
  ].join("\n");
  assert.equal(checkResult(await audit(readyFiles(at40), baseConfig()), "C4"), "PASS");
  const at41 = [
    "# Runbook",
    ...Array(39).fill("filler line"),
    "https://status.cloud.microsoft/m365",
  ].join("\n");
  assert.equal(checkResult(await audit(readyFiles(at41), baseConfig()), "C4"), "FAIL");
});

test("C4: SKIPPED when no critical vendor has a status page URL", async () => {
  const cfg = baseConfig({
    vendors: [{ name: "Microsoft 365", criticality: "critical" }],
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C1"), "FAIL"); // no URL is still CRITICAL for C1
  assert.equal(checkResult(r, "C4"), "SKIPPED");
});

// ---- C5 scoped negation ----

test("C5: negation scopes to its own clause - 'Do not reinstall, but rebuild' flags rebuild", async () => {
  const runbook = `# Runbook

Step 1: Check the vendor status page first:
https://status.cloud.microsoft/m365

Do not reinstall the app, but rebuild the cache now.
`;
  const r = await audit(readyFiles(runbook), baseConfig());
  const found = findingsFor(r, "C5");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"rebuild"/);
});

test("C5: a phrase before the negation is still flagged", async () => {
  const runbook = `# Runbook

Step 1: Check the vendor status page first:
https://status.cloud.microsoft/m365

Rebuild the cache, do not reinstall the app.
`;
  const r = await audit(readyFiles(runbook), baseConfig());
  const found = findingsFor(r, "C5");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"rebuild"/);
});

// ---- C7 missing escalation ----

test("C7: missing escalation (or only a primary) is HIGH", async () => {
  const cfg = baseConfig();
  delete cfg.escalation;
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C7"), "FAIL");
  assert.equal(findingsFor(r, "C7")[0].severity, "HIGH");
  assert.match(findingsFor(r, "C7")[0].message, /both a primary and a backup/);
  const primaryOnly = baseConfig({
    escalation: { primary: { name: "On-call lead", channel: "phone" } },
  });
  assert.equal(checkResult(await audit(readyFiles(), primaryOnly), "C7"), "FAIL");
});

// ---- C8 placeholder lines + per-claim ----

test("C8: a claim on a {{vendor_cause}} line is still flagged", async () => {
  const tpl = `# Staff announcement

The vendor published cause is: {{vendor_cause}} because of a bad deploy.
`;
  const r = await audit(readyFiles(GOOD_RUNBOOK, tpl), baseConfig());
  const found = findingsFor(r, "C8").filter((f) => f.message.includes("asserts a cause"));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /because of/);
});

test("C8: two cause claims on one line are two findings", async () => {
  const tpl = `# Staff announcement

The outage was caused by a failed upgrade and due to a bad deploy.
`;
  const r = await audit(readyFiles(GOOD_RUNBOOK, tpl), baseConfig());
  const found = findingsFor(r, "C8").filter((f) => f.message.includes("asserts a cause"));
  assert.equal(found.length, 2);
  assert.equal(found[0].line, found[1].line);
  assert.match(found.map((f) => f.message).join(" "), /caused by/);
  assert.match(found.map((f) => f.message).join(" "), /due to/);
});

test("C8: missing template file is HIGH", async () => {
  const cfg = baseConfig({ commsTemplate: "templates/no-such-file.md" });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C8"), "FAIL");
  assert.match(findingsFor(r, "C8")[0].message, /not found/);
});

test("C8: a template path matching a secret-file pattern is never read", async () => {
  const cfg = baseConfig({ commsTemplate: "templates/secret.md" });
  const files = {
    "runbooks/microsoft-365.md": GOOD_RUNBOOK,
    "templates/secret.md": GOOD_TEMPLATE,
  };
  const r = await audit(files, cfg);
  assert.equal(checkResult(r, "C8"), "FAIL");
  assert.match(findingsFor(r, "C8")[0].message, /not found/);
});

// ---- C2 partial-offline note in the table ----

test("C2: partial-offline note is carried in JSON and shown in the table", async () => {
  const awsRunbook = `# Runbook

Step 1: Check the vendor status page first:
https://status.aws.amazon.com

Do not reinstall anything - there is no local fix.
`;
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/microsoft-365.md",
        criticality: "critical",
      },
      {
        name: "AWS",
        statusPageUrl: "https://status.aws.amazon.com",
        runbook: "runbooks/aws.md",
        criticality: "critical",
      },
    ],
  });
  const files = {
    "runbooks/microsoft-365.md": GOOD_RUNBOOK,
    "runbooks/aws.md": awsRunbook,
    "templates/staff-announcement.md": GOOD_TEMPLATE,
  };
  const dir = makeDir(files);
  try {
    const r = await auditDir(dir, validateConfig(cfg), "0.1.0", {
      now: NOW,
      headCheck: async (url) => (url.includes("microsoft") ? "ok" : "offline"),
    });
    const c2 = r.checks.find((c) => c.id === "C2");
    assert.equal(c2.result, "PASS");
    assert.match(c2.note, /1 of 2 status pages could not be reached/);
    const table = renderTable(r);
    assert.ok(table.includes("note: 1 of 2 status pages could not be reached"), table);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- phone redaction: 7-digit rule, IPs and dates untouched ----

test("privacy: 7-digit numbers redact, IPs and ISO dates do not", () => {
  const redacted = redactEvidence("call 5551234 now");
  assert.ok(!redacted.includes("5551234"), redacted);
  assert.ok(redacted.includes("[redacted]"), redacted);
  assert.equal(redactEvidence("check server 10.0.0.1 now"), "check server 10.0.0.1 now");
  assert.equal(
    redactEvidence("check server 192.168.53.230 now"),
    "check server 192.168.53.230 now",
  );
  assert.equal(redactEvidence("drill on 2026-11-14 went well"), "drill on 2026-11-14 went well");
  const formatted = redactEvidence("call (555) 123-4567 now");
  assert.ok(!formatted.includes("555"), formatted);
  assert.ok(formatted.includes("[redacted]"), formatted);
});

// ---- strict ISO dates ----

test("dates: impossible calendar dates are rejected, real ones are not", () => {
  assert.equal(isValidIsoDate("2026-02-30"), false);
  assert.equal(isValidIsoDate("2026-13-01"), false);
  assert.equal(isValidIsoDate("2026-11-14"), true);
  assert.equal(isValidIsoDate("2026-11-14T00:00:00Z"), false);
});

test("C6/C10: an impossible date warns as 'not an ISO date'", async () => {
  const cfg = baseConfig({ lastDrill: "2026-02-30" });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C10"), "WARN");
  assert.match(findingsFor(r, "C10")[0].message, /not an ISO date/);
  const cfg2 = baseConfig({
    fallbackChannel: { type: "sms", name: "SMS group", lastTested: "2026-02-30" },
  });
  const r2 = await audit(readyFiles(), cfg2);
  assert.equal(checkResult(r2, "C6"), "WARN");
  assert.match(findingsFor(r2, "C6")[0].message, /not an ISO date/);
});

// ---- threshold validation + optional-vendor C1 ----

test("config: unknown or negative thresholds are rejected", () => {
  assert.throws(() => validateConfig(baseConfig({ thresholds: { nope: 1 } })), /unknown threshold/);
  assert.throws(
    () => validateConfig(baseConfig({ thresholds: { fallbackTestMaxDays: -1 } })),
    /must be a non-negative number/,
  );
  assert.throws(
    () => validateConfig(baseConfig({ thresholds: { drillMaxDays: "soon" } })),
    /must be a non-negative number/,
  );
});

test("C1: an optional vendor without a status page is no finding", async () => {
  const cfg = baseConfig({
    vendors: [
      {
        name: "Microsoft 365",
        statusPageUrl: "https://status.cloud.microsoft/m365",
        runbook: "runbooks/microsoft-365.md",
        criticality: "critical",
      },
      { name: "Acme Analytics", criticality: "optional" },
    ],
  });
  const r = await audit(readyFiles(), cfg);
  assert.equal(checkResult(r, "C1"), "PASS");
  assert.equal(findingsFor(r, "C1").length, 0);
});
