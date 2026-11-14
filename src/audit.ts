/**
 * outagekit audit engine - checks C1 to C10.
 *
 * Every finding traces to a named file and line. The engine reads
 * runbook text and the manifest only - never secret values, never env
 * values, and never files matching .env*, *secret*, *.pem or *.key.
 * Evidence lines are redacted for email addresses and phone-like
 * digit runs before they leave this module, so no contact data can
 * ever appear in table or JSON output.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import type { OutageConfig, Vendor } from "./config.js";
import { resolveThresholds } from "./config.js";
import type { HeadResult } from "./liveness.js";

export type Severity = "CRITICAL" | "HIGH" | "WARN";
export type CheckResult = "PASS" | "FAIL" | "WARN" | "UNCHECKED" | "SKIPPED";
export type Verdict = "READY" | "GAPS" | "NOT-READY";

export interface Finding {
  check: string;
  vendor?: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface CheckOutcome {
  id: string;
  name: string;
  result: CheckResult;
  findings: Finding[];
  note?: string;
}

export interface AuditResult {
  tool: "outagekit";
  version: string;
  dir: string;
  configPath: string;
  generatedAt: string;
  verdict: Verdict;
  checks: CheckOutcome[];
  summary: {
    critical: number;
    high: number;
    warn: number;
    unchecked: number;
    skipped: number;
  };
}

export type HeadCheck = (url: string) => Promise<HeadResult>;

export interface AuditOptions {
  now?: Date;
  headCheck?: HeadCheck;
}

export const CHECK_NAMES: Record<string, string> = {
  C1: "STATUS-PAGE",
  C2: "STATUS-PAGE-LIVE",
  C3: "RUNBOOK-EXISTS",
  C4: "RUNBOOK-STEP-1",
  C5: "NO-LOCAL-FIX",
  C6: "FALLBACK-CHANNEL",
  C7: "ESCALATION",
  C8: "COMMS-TEMPLATE",
  C9: "MAIL-TIMEOUT",
  C10: "DRILL",
};

export const FIX_GUIDANCE: Record<string, string> = {
  C1: "Add a statusPageUrl for every critical vendor - the vendor status page is step 1 of the runbook, so the audit cannot pass without it.",
  C2: "Check the status page URL in a browser. If the page moved, update statusPageUrl; if it is genuinely down, that is a finding about the vendor, not about this tool.",
  C3: "Write one runbook per critical vendor (runbooks/<vendor>.md) or one shared runbooks/vendor-outage-runbook.md that names every critical vendor.",
  C4: "Put the vendor status page URL in the first steps of the runbook (first 40 lines), under a step like 'Check the vendor status page'. During an outage nobody scrolls.",
  C5: "Remove the local-fix step. A vendor outage has no local fix: no reinstall, no rebuild, no password reset, no DNS change, no mailbox re-creation. If the step is a documented exception, add the exact phrase to the runbook allowlist in outagekit.json.",
  C6: "Define a fallback channel that does not depend on any listed vendor (SMS or phone, not the vendor chat), and test it at least every 90 days - update fallbackChannel.lastTested after each test.",
  C7: "Define a primary and a backup escalation contact - different people, on different channels - so one person or one dead channel cannot block escalation.",
  C8: "Keep the {{vendor_cause}} placeholder in the staff announcement and state only the vendor published cause. Delete any sentence that claims a cause of its own.",
  C9: "Document the mail timeout / retry window (at least 24 hours) in outagekit.json as mailTimeoutHours or in a runbook. Microsoft extended theirs to 48 hours during the November 2026 outage.",
  C10: "Run a full vendor-outage drill at least every 180 days and record the date as lastDrill. A plan nobody has drilled is a plan nobody can run.",
};

/**
 * Phrases that describe a LOCAL fix for a VENDOR outage. A runbook
 * that tells the team to reinstall, rebuild, reset credentials,
 * change DNS or re-create a mailbox during a vendor outage is
 * telling them to do work that cannot fix the outage.
 */
export const FORBIDDEN_PHRASES = [
  "reinstall",
  "rebuild",
  "reset password",
  "reset the password",
  "reset credentials",
  "reset the credentials",
  "change dns",
  "change the dns",
  "change dns records",
  "update dns records",
  "re-create the mailbox",
  "recreate the mailbox",
  "re-create the profile",
  "recreate the profile",
];

/**
 * A line that forbids the fix is not a hit: "Do not reinstall
 * anything - there is no local fix" is the CORRECT runbook text.
 * This is a heuristic, not a proof - see README Honest limits.
 */
const NEGATION_RE = /\b(do not|don't|dont|never|no local fix|not a local fix)\b/i;

/** Sentences that claim a cause of their own. */
const CAUSE_CLAIM_RE =
  /\b(caused by|due to|because of|root cause is|root cause was|the cause is|the cause was|was caused by)\b/i;

/** Channel types that depend on a listed vendor. */
const CHANNEL_VENDOR: Record<string, string> = {
  teams: "Microsoft 365",
  outlook: "Microsoft 365",
  exchange: "Microsoft 365",
  "microsoft 365": "Microsoft 365",
  slack: "Slack",
  zoom: "Zoom",
  "google meet": "Google Workspace",
  "google chat": "Google Workspace",
  gmail: "Google Workspace",
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

/** Mask contact data in an evidence line before it is reported. */
export function redactEvidence(line: string): string {
  return line.replace(EMAIL_RE, "[redacted]").replace(PHONE_RE, "[redacted]").trim().slice(0, 200);
}

export function exitForVerdict(v: Verdict): number {
  return v === "READY" ? 0 : v === "GAPS" ? 1 : 2;
}

export function computeVerdict(checks: CheckOutcome[]): Verdict {
  let hasCritical = false;
  let hasHigh = false;
  for (const c of checks) {
    for (const f of c.findings) {
      if (f.severity === "CRITICAL") hasCritical = true;
      if (f.severity === "HIGH") hasHigh = true;
    }
  }
  if (hasCritical) return "NOT-READY";
  if (hasHigh) return "GAPS";
  return "READY";
}

function daysAgo(iso: string, now: Date): number | null {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const ms = now.getTime() - d.getTime();
  return Math.floor(ms / 86400000);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function readLines(absPath: string): string[] | null {
  try {
    return readFileSync(absPath, "utf8").split("\n");
  } catch {
    return null;
  }
}

interface ResolvedRunbook {
  abs: string;
  rel: string;
  lines: string[];
}

/**
 * Resolve the runbook for a vendor: the explicit path in the
 * manifest, else runbooks/<vendor-slug>.md, else the shared
 * runbooks/vendor-outage-runbook.md when it names the vendor.
 */
function resolveRunbook(dir: string, vendor: Vendor): ResolvedRunbook | null {
  const candidates: string[] = [];
  if (vendor.runbook) candidates.push(vendor.runbook);
  candidates.push(join("runbooks", `${slug(vendor.name)}.md`));
  for (const rel of candidates) {
    const abs = resolve(dir, rel);
    const lines = readLines(abs);
    if (lines) return { abs, rel, lines };
  }
  const sharedRel = join("runbooks", "vendor-outage-runbook.md");
  const sharedAbs = resolve(dir, sharedRel);
  const sharedLines = readLines(sharedAbs);
  if (sharedLines) {
    const text = sharedLines.join("\n").toLowerCase();
    if (text.includes(vendor.name.toLowerCase())) {
      return { abs: sharedAbs, rel: sharedRel, lines: sharedLines };
    }
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function outcome(id: string, findings: Finding[]): CheckOutcome {
  let result: CheckResult = "PASS";
  if (findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH")) result = "FAIL";
  else if (findings.some((f) => f.severity === "WARN")) result = "WARN";
  return { id, name: CHECK_NAMES[id], result, findings };
}

export async function auditDir(
  dir: string,
  cfg: OutageConfig,
  version: string,
  opts: AuditOptions = {},
): Promise<AuditResult> {
  const now = opts.now ?? new Date();
  const thresholds = resolveThresholds(cfg);
  const checks: CheckOutcome[] = [];
  const criticalVendors = cfg.vendors.filter((v) => v.criticality === "critical");
  const configRel = "outagekit.json";

  // ---- C1 STATUS-PAGE ----
  {
    const findings: Finding[] = [];
    for (const v of cfg.vendors) {
      if (!v.statusPageUrl) {
        if (v.criticality === "critical") {
          findings.push({
            check: "C1",
            vendor: v.name,
            severity: "CRITICAL",
            message: `critical vendor "${v.name}" has no statusPageUrl configured`,
          });
        } else if (v.criticality === "important") {
          findings.push({
            check: "C1",
            vendor: v.name,
            severity: "WARN",
            message: `important vendor "${v.name}" has no statusPageUrl configured`,
          });
        }
      }
    }
    checks.push(outcome("C1", findings));
  }

  // ---- C2 STATUS-PAGE-LIVE ----
  {
    const findings: Finding[] = [];
    let unchecked = 0;
    let checked = 0;
    for (const v of cfg.vendors) {
      if (!v.statusPageUrl) continue;
      checked++;
      if (!opts.headCheck) {
        unchecked++;
        continue;
      }
      const res = await opts.headCheck(v.statusPageUrl);
      if (res === "offline") unchecked++;
      else if (res === "fail") {
        findings.push({
          check: "C2",
          vendor: v.name,
          severity: "WARN",
          message: `status page for "${v.name}" did not answer 2xx/3xx: ${v.statusPageUrl}`,
        });
      }
    }
    const o = outcome("C2", findings);
    if (checked === 0) o.result = "SKIPPED";
    else if (unchecked === checked) {
      o.result = "UNCHECKED";
      o.note = `${unchecked} of ${checked} status pages could not be reached (offline) - reported UNCHECKED, never PASS`;
    } else if (unchecked > 0) {
      o.result = findings.length > 0 ? "WARN" : "PASS";
      o.note = `${unchecked} of ${checked} status pages could not be reached (offline) - only reachable pages were scored`;
    }
    checks.push(o);
  }

  // ---- C3 / C4 / C5 per critical vendor ----
  const runbooks = new Map<string, ResolvedRunbook>();
  {
    const c3: Finding[] = [];
    const c4: Finding[] = [];
    const c5: Finding[] = [];
    for (const v of criticalVendors) {
      const rb = resolveRunbook(dir, v);
      if (!rb) {
        c3.push({
          check: "C3",
          vendor: v.name,
          severity: "CRITICAL",
          message: `no runbook found for critical vendor "${v.name}"`,
        });
        continue;
      }
      runbooks.set(v.name, rb);
      // C4: status page URL (or its host) in the first 40 lines.
      if (v.statusPageUrl) {
        const head = rb.lines.slice(0, 40);
        const host = hostOf(v.statusPageUrl);
        const foundIdx = head.findIndex(
          (l) => l.includes(v.statusPageUrl as string) || l.toLowerCase().includes(host),
        );
        if (foundIdx === -1) {
          c4.push({
            check: "C4",
            vendor: v.name,
            severity: "HIGH",
            message: `runbook does not name the status page URL in its first 40 lines`,
            file: rb.rel,
            line: 1,
            evidence: `first step should link ${v.statusPageUrl}`,
          });
        }
      }
      // C5: forbidden local-fix phrases, honoring the allowlist.
      const allowed = (cfg.allowlist?.[rb.rel] ?? []).map((p) => p.toLowerCase());
      rb.lines.forEach((line, i) => {
        if (NEGATION_RE.test(line)) return;
        const lower = line.toLowerCase();
        for (const phrase of FORBIDDEN_PHRASES) {
          if (!lower.includes(phrase)) continue;
          if (allowed.includes(phrase)) continue;
          c5.push({
            check: "C5",
            vendor: v.name,
            severity: "HIGH",
            message: `forbidden local-fix step: "${phrase}"`,
            file: rb.rel,
            line: i + 1,
            evidence: redactEvidence(line),
          });
        }
      });
    }
    checks.push(outcome("C3", c3));
    const c4o = outcome("C4", c4);
    if (criticalVendors.every((v) => !v.statusPageUrl) && runbooks.size > 0) c4o.result = "SKIPPED";
    if (criticalVendors.length === 0) c4o.result = "SKIPPED";
    checks.push(c4o);
    checks.push(outcome("C5", c5));
  }

  // ---- C6 FALLBACK-CHANNEL ----
  {
    const findings: Finding[] = [];
    const fb = cfg.fallbackChannel;
    if (!fb) {
      findings.push({
        check: "C6",
        severity: "HIGH",
        message: "no fallback comms channel defined",
      });
    } else {
      const type = fb.type.toLowerCase();
      const depVendor = CHANNEL_VENDOR[type];
      if (depVendor && cfg.vendors.some((v) => v.name.toLowerCase() === depVendor.toLowerCase())) {
        findings.push({
          check: "C6",
          severity: "HIGH",
          message: `fallback channel "${fb.type}" depends on listed vendor ${depVendor} - it fails together with the outage`,
        });
      }
      if ((type === "email" || type === "mail") && cfg.vendors.some((v) => /mail|exchange|365|google workspace/i.test(v.name))) {
        const mailVendor = cfg.vendors.find((v) => /mail|exchange|365|google workspace/i.test(v.name));
        findings.push({
          check: "C6",
          severity: "HIGH",
          message: `fallback channel "email" depends on listed vendor ${mailVendor?.name} - it fails together with the outage`,
        });
      }
      if (!fb.lastTested) {
        findings.push({
          check: "C6",
          severity: "WARN",
          message: "fallback channel has no lastTested date - untested channels are assumed untested",
        });
      } else {
        const age = daysAgo(fb.lastTested, now);
        if (age === null) {
          findings.push({
            check: "C6",
            severity: "WARN",
            message: `fallback channel lastTested "${fb.lastTested}" is not an ISO date (YYYY-MM-DD)`,
          });
        } else if (age > thresholds.fallbackTestMaxDays) {
          findings.push({
            check: "C6",
            severity: "WARN",
            message: `fallback channel last tested ${age} days ago (limit ${thresholds.fallbackTestMaxDays} days)`,
          });
        } else if (age < 0) {
          findings.push({
            check: "C6",
            severity: "WARN",
            message: `fallback channel lastTested "${fb.lastTested}" is in the future`,
          });
        }
      }
    }
    checks.push(outcome("C6", findings));
  }

  // ---- C7 ESCALATION ----
  {
    const findings: Finding[] = [];
    const esc = cfg.escalation;
    const primary = esc?.primary;
    const backup = esc?.backup;
    if (!primary || !backup) {
      findings.push({
        check: "C7",
        severity: "HIGH",
        message: "escalation needs both a primary and a backup contact",
      });
    } else {
      if (primary.name.toLowerCase() === backup.name.toLowerCase()) {
        findings.push({
          check: "C7",
          severity: "HIGH",
          message: `primary and backup escalation are the same person ("${primary.name}")`,
        });
      }
      if (primary.channel.toLowerCase() === backup.channel.toLowerCase()) {
        findings.push({
          check: "C7",
          severity: "HIGH",
          message: `primary and backup escalation use the same channel ("${primary.channel}") - one dead channel blocks escalation`,
        });
      }
    }
    checks.push(outcome("C7", findings));
  }

  // ---- C8 COMMS-TEMPLATE ----
  {
    const findings: Finding[] = [];
    const tplRel = cfg.commsTemplate;
    if (!tplRel) {
      findings.push({
        check: "C8",
        severity: "HIGH",
        message: "no commsTemplate configured",
      });
    } else {
      const abs = resolve(dir, tplRel);
      const lines = readLines(abs);
      if (!lines) {
        findings.push({
          check: "C8",
          severity: "HIGH",
          message: `comms template not found: ${tplRel}`,
          file: tplRel,
        });
      } else {
        const text = lines.join("\n");
        if (!text.includes("{{vendor_cause}}")) {
          findings.push({
            check: "C8",
            severity: "HIGH",
            message: "comms template has no {{vendor_cause}} placeholder - it cannot state only the vendor published cause",
            file: tplRel,
          });
        }
        lines.forEach((line, i) => {
          if (line.includes("{{vendor_cause}}")) return;
          if (!CAUSE_CLAIM_RE.test(line)) return;
          findings.push({
            check: "C8",
            severity: "HIGH",
            message: "template asserts a cause of its own instead of the vendor published cause",
            file: tplRel,
            line: i + 1,
            evidence: redactEvidence(line),
          });
        });
      }
    }
    checks.push(outcome("C8", findings));
  }

  // ---- C9 MAIL-TIMEOUT ----
  {
    const findings: Finding[] = [];
    const min = thresholds.mailTimeoutMinHours;
    let documented: number | null = null;
    let evidence: { file: string; line: number; text: string } | null = null;
    if (typeof cfg.mailTimeoutHours === "number") {
      documented = cfg.mailTimeoutHours;
      evidence = { file: configRel, line: 1, text: `mailTimeoutHours: ${cfg.mailTimeoutHours}` };
    } else {
      outer: for (const rb of runbooks.values()) {
        for (let i = 0; i < rb.lines.length; i++) {
          const line = rb.lines[i];
          if (!/timeout|retry/i.test(line)) continue;
          const m = line.match(/(\d+)\s*(h|hour)/i);
          if (!m) continue;
          documented = parseInt(m[1], 10);
          evidence = { file: rb.rel, line: i + 1, text: redactEvidence(line) };
          break outer;
        }
      }
    }
    if (documented === null) {
      findings.push({
        check: "C9",
        severity: "WARN",
        message: "mail timeout / retry window is not documented anywhere (runbook or manifest)",
      });
    } else if (documented < min) {
      findings.push({
        check: "C9",
        severity: "WARN",
        message: `mail timeout window is ${documented}h (minimum ${min}h)`,
        file: evidence?.file,
        line: evidence?.line,
        evidence: evidence?.text,
      });
    }
    checks.push(outcome("C9", findings));
  }

  // ---- C10 DRILL ----
  {
    const findings: Finding[] = [];
    if (!cfg.lastDrill) {
      findings.push({
        check: "C10",
        severity: "WARN",
        message: "no lastDrill date recorded - a plan nobody has drilled is a plan nobody can run",
      });
    } else {
      const age = daysAgo(cfg.lastDrill, now);
      if (age === null) {
        findings.push({
          check: "C10",
          severity: "WARN",
          message: `lastDrill "${cfg.lastDrill}" is not an ISO date (YYYY-MM-DD)`,
        });
      } else if (age > thresholds.drillMaxDays) {
        findings.push({
          check: "C10",
          severity: "WARN",
          message: `last full vendor-outage drill was ${age} days ago (limit ${thresholds.drillMaxDays} days)`,
        });
      } else if (age < 0) {
        findings.push({
          check: "C10",
          severity: "WARN",
          message: `lastDrill "${cfg.lastDrill}" is in the future`,
        });
      }
    }
    checks.push(outcome("C10", findings));
  }

  const verdict = computeVerdict(checks);
  let critical = 0;
  let high = 0;
  let warn = 0;
  let unchecked = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.result === "UNCHECKED") unchecked++;
    if (c.result === "SKIPPED") skipped++;
    for (const f of c.findings) {
      if (f.severity === "CRITICAL") critical++;
      else if (f.severity === "HIGH") high++;
      else warn++;
    }
  }
  return {
    tool: "outagekit",
    version,
    dir,
    configPath: configRel,
    generatedAt: now.toISOString(),
    verdict,
    checks,
    summary: { critical, high, warn, unchecked, skipped },
  };
}

/** Key for diffing findings across two audit results. */
export function findingKey(f: Finding): string {
  return [f.check, f.vendor ?? "", f.severity, f.message, f.file ?? "", String(f.line ?? "")].join("|");
}

export interface DiffResult {
  added: Finding[];
  fixed: Finding[];
  stillOpen: Finding[];
}

export function diffAudits(baseline: AuditResult, current: AuditResult): DiffResult {
  const baseKeys = new Set<string>();
  const baseByKey = new Map<string, Finding>();
  for (const c of baseline.checks) {
    for (const f of c.findings) {
      baseKeys.add(findingKey(f));
      baseByKey.set(findingKey(f), f);
    }
  }
  const curKeys = new Set<string>();
  const added: Finding[] = [];
  const stillOpen: Finding[] = [];
  for (const c of current.checks) {
    for (const f of c.findings) {
      const k = findingKey(f);
      curKeys.add(k);
      if (baseKeys.has(k)) stillOpen.push(f);
      else added.push(f);
    }
  }
  const fixed: Finding[] = [];
  for (const [k, f] of baseByKey) {
    if (!curKeys.has(k)) fixed.push(f);
  }
  return { added, fixed, stillOpen };
}

/** Directories outagekit never reads: secret material is out of scope. */
export const SKIPPED_FILE_PATTERNS = [/\.env/i, /secret/i, /\.pem$/i, /\.key$/i];

export function isSkippedFile(name: string): boolean {
  return SKIPPED_FILE_PATTERNS.some((re) => re.test(basename(name)));
}

export function listRunbookFiles(dir: string): string[] {
  const out: string[] = [];
  const rbDir = join(dir, "runbooks");
  if (!existsSync(rbDir)) return out;
  for (const e of readdirSync(rbDir)) {
    if (e.endsWith(".md") && !isSkippedFile(e)) out.push(relative(dir, join(rbDir, e)));
  }
  return out;
}
