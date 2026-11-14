/**
 * Report rendering: table, JSON passthrough, explain, diff.
 *
 * The table is the human view: one row per check, evidence as
 * file:line. JSON is the machine view: the full AuditResult.
 * Nothing here prints file contents beyond a single matched line,
 * and every evidence line passes through redactEvidence() upstream.
 */
import type { AuditResult, CheckOutcome, DiffResult, Finding } from "./audit.js";
import { CHECK_NAMES, FIX_GUIDANCE } from "./audit.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function renderTable(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`outagekit audit - ${result.dir}`);
  lines.push(
    `verdict: ${result.verdict}  (CRITICAL ${result.summary.critical}, HIGH ${result.summary.high}, WARN ${result.summary.warn})`,
  );
  lines.push("");
  lines.push(
    `${pad("check", 5)} ${pad("name", 17)} ${pad("result", 10)} ${pad("severity", 9)} evidence`,
  );
  lines.push("-".repeat(100));
  for (const c of result.checks) {
    const sev = c.findings.length > 0 ? c.findings[0].severity : "-";
    const ev = c.findings.length > 0 ? findingEvidence(c.findings[0]) : "";
    lines.push(
      `${pad(c.id, 5)} ${pad(c.name, 17)} ${pad(c.result, 10)} ${pad(sev, 9)} ${ev}`.trimEnd(),
    );
    for (const f of c.findings.slice(1)) {
      lines.push(
        `${pad("", 5)} ${pad("", 17)} ${pad("", 10)} ${pad(f.severity, 9)} ${findingEvidence(f)}`.trimEnd(),
      );
    }
    if (c.note) lines.push(`      note: ${c.note}`);
  }
  lines.push("");
  lines.push(
    `summary: ${result.summary.critical} CRITICAL, ${result.summary.high} HIGH, ${result.summary.warn} WARN, ${result.summary.unchecked} UNCHECKED, ${result.summary.skipped} SKIPPED`,
  );
  return lines.join("\n");
}

function findingEvidence(f: Finding): string {
  const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
  const scope = f.vendor ? `[${f.vendor}] ` : "";
  const msg = `${scope}${f.message}`;
  const short = msg.length > 78 ? `${msg.slice(0, 75)}...` : msg;
  return `${short}${where ? ` (${where})` : ""}`;
}

function wrap(text: string, width = 110): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width && cur.length > 0) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function renderExplain(result: AuditResult, checkId: string): string {
  const id = checkId.toUpperCase();
  const check: CheckOutcome | undefined = result.checks.find((c) => c.id === id);
  if (!check) {
    return `unknown check: ${checkId}\nknown checks: ${Object.keys(CHECK_NAMES).join(", ")}`;
  }
  const lines: string[] = [];
  lines.push(`explain ${id} - ${check.name}`);
  lines.push(`result: ${check.result}  (verdict ${result.verdict})`);
  lines.push("");
  lines.push(`rule: ${wrap(ruleText(id))[0]}`);
  for (const extra of wrap(ruleText(id)).slice(1)) lines.push(`      ${extra}`);
  lines.push("");
  if (check.findings.length === 0) {
    lines.push("findings: none - this check passed.");
  } else {
    lines.push(`findings (${check.findings.length}):`);
    for (const f of check.findings) {
      const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
      lines.push(`  [${f.severity}] ${f.message}${where ? ` (${where})` : ""}`);
      if (f.evidence) lines.push(`      evidence: ${f.evidence}`);
    }
  }
  if (check.note) lines.push(`note: ${check.note}`);
  lines.push("");
  const fixLines = wrap(`how to fix: ${FIX_GUIDANCE[id] ?? "See the README checks table."}`);
  lines.push(...fixLines);
  return lines.join("\n");
}

function ruleText(id: string): string {
  switch (id) {
    case "C1":
      return "Every critical vendor has a statusPageUrl configured (important vendors: WARN when missing).";
    case "C2":
      return "HEAD request to each configured status page URL returns 2xx/3xx (GET retry when HEAD is refused with 401/403/405). Offline pages report UNCHECKED, never PASS.";
    case "C3":
      return "A runbook file exists for every critical vendor, or the shared runbook names the vendor.";
    case "C4":
      return "The runbook names the vendor status page URL within its first 40 lines.";
    case "C5":
      return "The runbook contains no forbidden local-fix step (reinstall / rebuild / reset password or credentials / change DNS records / re-create the mailbox or profile). A negation (do not / never) before a phrase in the same clause is not a hit; a phrase after a clause break (comma, semicolon, but) is still flagged. The per-runbook allowlist covers documented exceptions.";
    case "C6":
      return "A fallback comms channel is defined on a channel that does not depend on any listed vendor, and lastTested is within the fallbackTestMaxDays threshold (default 90 days).";
    case "C7":
      return "Primary + backup escalation contacts are defined, on different channels, and are not the same person.";
    case "C8":
      return "The staff-announcement template exists, contains a {{vendor_cause}} placeholder, and asserts no root cause of its own.";
    case "C9":
      return "The mail timeout / retry window is documented (runbook or manifest) and at least mailTimeoutMinHours (default 24h).";
    case "C10":
      return "The last full vendor-outage drill was within the drillMaxDays threshold (default 180 days).";
    default:
      return "See the README checks table.";
  }
}

export function renderDiff(diff: DiffResult, baselinePath: string): string {
  const lines: string[] = [];
  lines.push(`outagekit diff - baseline ${baselinePath}`);
  lines.push("");
  lines.push(`NEW findings (${diff.added.length}):`);
  for (const f of diff.added) lines.push(`  + [${f.severity}] ${f.check} ${findingEvidence(f)}`);
  if (diff.added.length === 0) lines.push("  (none)");
  lines.push(`FIXED findings (${diff.fixed.length}):`);
  for (const f of diff.fixed) lines.push(`  - [${f.severity}] ${f.check} ${findingEvidence(f)}`);
  if (diff.fixed.length === 0) lines.push("  (none)");
  lines.push(`STILL-OPEN findings (${diff.stillOpen.length}):`);
  for (const f of diff.stillOpen)
    lines.push(`  = [${f.severity}] ${f.check} ${findingEvidence(f)}`);
  if (diff.stillOpen.length === 0) lines.push("  (none)");
  return lines.join("\n");
}

export function renderFailingFirst(result: AuditResult): string {
  const failing = result.checks.filter((c) => c.result === "FAIL" || c.result === "WARN");
  const passing = result.checks.filter((c) => c.result !== "FAIL" && c.result !== "WARN");
  const ordered: AuditResult = { ...result, checks: [...failing, ...passing] };
  return renderTable(ordered);
}
