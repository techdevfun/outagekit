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
import { readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { resolveThresholds } from "./config.js";
export const CHECK_NAMES = {
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
export const FIX_GUIDANCE = {
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
 * The negation is scoped to the matched phrase, not the whole
 * line: the negation must appear BEFORE the phrase in the same
 * clause (clauses break on comma, semicolon, colon or "but"), so
 * "Do not reinstall the app, but rebuild the cache now." still
 * flags "rebuild". This is a heuristic, not a proof - see README
 * Honest limits.
 */
const NEGATION_RE = /\b(do not|don't|dont|never|no local fix|not a local fix)\b/i;
/** Clause separators for the C5 negation scope (see above). */
const CLAUSE_SEP_RE = /[,;:]|\bbut\b/gi;
/** True when a negation precedes the phrase at `phraseIdx` in the same clause. */
function isNegatedBefore(line, phraseIdx) {
    const before = line.slice(0, phraseIdx);
    let start = 0;
    for (const m of before.matchAll(CLAUSE_SEP_RE)) {
        start = (m.index ?? 0) + m[0].length;
    }
    return NEGATION_RE.test(before.slice(start));
}
/** Sentences that claim a cause of their own. */
const CAUSE_CLAIM_RE = /\b(caused by|due to|because of|root cause is|root cause was|the cause is|the cause was|was caused by)\b/i;
/** Channel types that depend on a listed vendor. */
const CHANNEL_VENDOR = {
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
/**
 * A candidate phone-like token: an optional leading "+" or "(",
 * then digits mixed with the separators phones use (space, dot,
 * dash, parentheses). The digit count decides, not the run length:
 * the config privacy rule treats 7+ total digits as phone data
 * (see config.ts hasPhoneDigits), so redaction must use the same
 * rule - "call 5551234 now" is phone data even though it has no
 * separator. IPv4 addresses and ISO dates are NOT phone data and
 * are left alone, so evidence keeps its fidelity.
 */
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]*\d/g;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Mask contact data in an evidence line before it is reported. */
export function redactEvidence(line) {
    const noEmail = line.replace(EMAIL_RE, "[redacted]");
    const redacted = noEmail.replace(PHONE_CANDIDATE_RE, (m) => {
        if (m.replace(/\D/g, "").length < 7)
            return m;
        const token = m.trim();
        if (IPV4_RE.test(token) || ISO_DATE_RE.test(token))
            return m;
        return "[redacted]";
    });
    return redacted.trim().slice(0, 200);
}
export function exitForVerdict(v) {
    return v === "READY" ? 0 : v === "GAPS" ? 1 : 2;
}
export function computeVerdict(checks) {
    let hasCritical = false;
    let hasHigh = false;
    for (const c of checks) {
        for (const f of c.findings) {
            if (f.severity === "CRITICAL")
                hasCritical = true;
            if (f.severity === "HIGH")
                hasHigh = true;
        }
    }
    if (hasCritical)
        return "NOT-READY";
    if (hasHigh)
        return "GAPS";
    return "READY";
}
/** Strict ISO calendar date (YYYY-MM-DD): the round-trip check
 * rejects impossible dates like 2026-02-30, which the JS Date
 * constructor would silently normalise to 2 March. */
export function isValidIsoDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
        return false;
    const d = new Date(iso + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}
function daysAgo(iso, now) {
    if (!isValidIsoDate(iso))
        return null;
    const d = new Date(iso + "T00:00:00Z");
    const ms = now.getTime() - d.getTime();
    return Math.floor(ms / 86400000);
}
function slug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
function readLines(absPath) {
    try {
        return readFileSync(absPath, "utf8").split("\n");
    }
    catch {
        return null;
    }
}
/**
 * Resolve the runbook for a vendor: the explicit path in the
 * manifest, else runbooks/<vendor-slug>.md, else the shared
 * runbooks/vendor-outage-runbook.md when it names the vendor.
 */
function resolveRunbook(dir, vendor) {
    const candidates = [];
    if (vendor.runbook)
        candidates.push(vendor.runbook);
    candidates.push(join("runbooks", `${slug(vendor.name)}.md`));
    for (const rel of candidates) {
        if (isSkippedFile(rel))
            continue;
        const abs = resolve(dir, rel);
        const lines = readLines(abs);
        if (lines)
            return { abs, rel, lines };
    }
    const sharedRel = join("runbooks", "vendor-outage-runbook.md");
    if (isSkippedFile(sharedRel))
        return null;
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
function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    }
    catch {
        return url.toLowerCase();
    }
}
function outcome(id, findings) {
    let result = "PASS";
    if (findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH"))
        result = "FAIL";
    else if (findings.some((f) => f.severity === "WARN"))
        result = "WARN";
    return { id, name: CHECK_NAMES[id], result, findings };
}
export async function auditDir(dir, cfg, version, opts = {}) {
    const now = opts.now ?? new Date();
    const thresholds = resolveThresholds(cfg);
    const checks = [];
    const criticalVendors = cfg.vendors.filter((v) => v.criticality === "critical");
    const configRel = "outagekit.json";
    // ---- C1 STATUS-PAGE ----
    {
        const findings = [];
        for (const v of cfg.vendors) {
            if (!v.statusPageUrl) {
                if (v.criticality === "critical") {
                    findings.push({
                        check: "C1",
                        vendor: v.name,
                        severity: "CRITICAL",
                        message: `critical vendor "${v.name}" has no statusPageUrl configured`,
                    });
                }
                else if (v.criticality === "important") {
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
        const findings = [];
        let unchecked = 0;
        let checked = 0;
        for (const v of cfg.vendors) {
            if (!v.statusPageUrl)
                continue;
            checked++;
            if (!opts.headCheck) {
                unchecked++;
                continue;
            }
            const res = await opts.headCheck(v.statusPageUrl);
            if (res === "offline")
                unchecked++;
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
        if (checked === 0)
            o.result = "SKIPPED";
        else if (unchecked === checked) {
            o.result = "UNCHECKED";
            o.note = `${unchecked} of ${checked} status pages could not be reached (offline) - reported UNCHECKED, never PASS`;
        }
        else if (unchecked > 0) {
            o.result = findings.length > 0 ? "WARN" : "PASS";
            o.note = `${unchecked} of ${checked} status pages could not be reached (offline) - only reachable pages were scored`;
        }
        checks.push(o);
    }
    // ---- C3 / C4 / C5 per critical vendor ----
    const runbooks = new Map();
    {
        const c3 = [];
        const c4 = [];
        const c5 = [];
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
                const foundIdx = head.findIndex((l) => l.includes(v.statusPageUrl) || l.toLowerCase().includes(host));
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
            // One finding per phrase occurrence; a negation only
            // suppresses a phrase it precedes in the same clause.
            const allowed = (cfg.allowlist?.[rb.rel] ?? []).map((p) => p.toLowerCase());
            rb.lines.forEach((line, i) => {
                const lower = line.toLowerCase();
                for (const phrase of FORBIDDEN_PHRASES) {
                    if (allowed.includes(phrase))
                        continue;
                    let from = 0;
                    for (;;) {
                        const idx = lower.indexOf(phrase, from);
                        if (idx === -1)
                            break;
                        from = idx + phrase.length;
                        if (isNegatedBefore(line, idx))
                            continue;
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
                }
            });
        }
        checks.push(outcome("C3", c3));
        const c4o = outcome("C4", c4);
        if (criticalVendors.every((v) => !v.statusPageUrl) && runbooks.size > 0)
            c4o.result = "SKIPPED";
        if (criticalVendors.length === 0)
            c4o.result = "SKIPPED";
        checks.push(c4o);
        checks.push(outcome("C5", c5));
    }
    // ---- C6 FALLBACK-CHANNEL ----
    {
        const findings = [];
        const fb = cfg.fallbackChannel;
        if (!fb) {
            findings.push({
                check: "C6",
                severity: "HIGH",
                message: "no fallback comms channel defined",
            });
        }
        else {
            const type = fb.type.toLowerCase();
            const depVendor = CHANNEL_VENDOR[type];
            if (depVendor && cfg.vendors.some((v) => v.name.toLowerCase() === depVendor.toLowerCase())) {
                findings.push({
                    check: "C6",
                    severity: "HIGH",
                    message: `fallback channel "${fb.type}" depends on listed vendor ${depVendor} - it fails together with the outage`,
                });
            }
            if ((type === "email" || type === "mail") &&
                cfg.vendors.some((v) => /mail|exchange|365|google workspace/i.test(v.name))) {
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
            }
            else {
                const age = daysAgo(fb.lastTested, now);
                if (age === null) {
                    findings.push({
                        check: "C6",
                        severity: "WARN",
                        message: `fallback channel lastTested "${fb.lastTested}" is not an ISO date (YYYY-MM-DD)`,
                    });
                }
                else if (age > thresholds.fallbackTestMaxDays) {
                    findings.push({
                        check: "C6",
                        severity: "WARN",
                        message: `fallback channel last tested ${age} days ago (limit ${thresholds.fallbackTestMaxDays} days)`,
                    });
                }
                else if (age < 0) {
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
        const findings = [];
        const esc = cfg.escalation;
        const primary = esc?.primary;
        const backup = esc?.backup;
        if (!primary || !backup) {
            findings.push({
                check: "C7",
                severity: "HIGH",
                message: "escalation needs both a primary and a backup contact",
            });
        }
        else {
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
        const findings = [];
        const tplRel = cfg.commsTemplate;
        if (!tplRel) {
            findings.push({
                check: "C8",
                severity: "HIGH",
                message: "no commsTemplate configured",
            });
        }
        else {
            const abs = resolve(dir, tplRel);
            const lines = isSkippedFile(tplRel) ? null : readLines(abs);
            if (!lines) {
                findings.push({
                    check: "C8",
                    severity: "HIGH",
                    message: `comms template not found: ${tplRel}`,
                    file: tplRel,
                });
            }
            else {
                const text = lines.join("\n");
                if (!text.includes("{{vendor_cause}}")) {
                    findings.push({
                        check: "C8",
                        severity: "HIGH",
                        message: "comms template has no {{vendor_cause}} placeholder - it cannot state only the vendor published cause",
                        file: tplRel,
                    });
                }
                // One finding per cause claim, not per line. A line that
                // contains the {{vendor_cause}} placeholder is still
                // scanned: only the placeholder itself (and the words
                // introducing it, "The vendor published cause is:") are
                // ignored - a claim elsewhere on the same line is a hit.
                lines.forEach((line, i) => {
                    const segments = line.split("{{vendor_cause}}");
                    segments.forEach((seg, si) => {
                        let scan = seg;
                        if (si < segments.length - 1) {
                            scan = scan.replace(/(the\s+vendor\s+published\s+cause\s+is|the\s+cause\s+is|cause\s+is)\s*:?\s*$/i, "");
                        }
                        const re = new RegExp(CAUSE_CLAIM_RE.source, "gi");
                        let m;
                        while ((m = re.exec(scan)) !== null) {
                            findings.push({
                                check: "C8",
                                severity: "HIGH",
                                message: `template asserts a cause of its own ("${m[0].toLowerCase()}") instead of the vendor published cause`,
                                file: tplRel,
                                line: i + 1,
                                evidence: redactEvidence(line),
                            });
                        }
                    });
                });
            }
        }
        checks.push(outcome("C8", findings));
    }
    // ---- C9 MAIL-TIMEOUT ----
    {
        const findings = [];
        const min = thresholds.mailTimeoutMinHours;
        let documented = null;
        let evidence = null;
        if (typeof cfg.mailTimeoutHours === "number") {
            documented = cfg.mailTimeoutHours;
            evidence = { file: configRel, line: 1, text: `mailTimeoutHours: ${cfg.mailTimeoutHours}` };
        }
        else {
            outer: for (const rb of runbooks.values()) {
                for (let i = 0; i < rb.lines.length; i++) {
                    const line = rb.lines[i];
                    if (!/timeout|retry/i.test(line))
                        continue;
                    const m = line.match(/(\d+)\s*(h|hour)/i);
                    if (!m)
                        continue;
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
        }
        else if (documented < min) {
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
        const findings = [];
        if (!cfg.lastDrill) {
            findings.push({
                check: "C10",
                severity: "WARN",
                message: "no lastDrill date recorded - a plan nobody has drilled is a plan nobody can run",
            });
        }
        else {
            const age = daysAgo(cfg.lastDrill, now);
            if (age === null) {
                findings.push({
                    check: "C10",
                    severity: "WARN",
                    message: `lastDrill "${cfg.lastDrill}" is not an ISO date (YYYY-MM-DD)`,
                });
            }
            else if (age > thresholds.drillMaxDays) {
                findings.push({
                    check: "C10",
                    severity: "WARN",
                    message: `last full vendor-outage drill was ${age} days ago (limit ${thresholds.drillMaxDays} days)`,
                });
            }
            else if (age < 0) {
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
        if (c.result === "UNCHECKED")
            unchecked++;
        if (c.result === "SKIPPED")
            skipped++;
        for (const f of c.findings) {
            if (f.severity === "CRITICAL")
                critical++;
            else if (f.severity === "HIGH")
                high++;
            else
                warn++;
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
export function findingKey(f) {
    return [f.check, f.vendor ?? "", f.severity, f.message, f.file ?? "", String(f.line ?? "")].join("|");
}
export function diffAudits(baseline, current) {
    const baseKeys = new Set();
    const baseByKey = new Map();
    for (const c of baseline.checks) {
        for (const f of c.findings) {
            baseKeys.add(findingKey(f));
            baseByKey.set(findingKey(f), f);
        }
    }
    const curKeys = new Set();
    const added = [];
    const stillOpen = [];
    for (const c of current.checks) {
        for (const f of c.findings) {
            const k = findingKey(f);
            curKeys.add(k);
            if (baseKeys.has(k))
                stillOpen.push(f);
            else
                added.push(f);
        }
    }
    const fixed = [];
    for (const [k, f] of baseByKey) {
        if (!curKeys.has(k))
            fixed.push(f);
    }
    return { added, fixed, stillOpen };
}
/**
 * Directories outagekit never reads: secret material is out of
 * scope. Runbooks are resolved only from paths named in the
 * manifest (plus the shared runbook); a manifest path matching
 * one of these patterns is treated as missing and never read,
 * and the same rule applies to the comms template. There is no
 * directory enumeration, so nothing outside the manifest is
 * ever opened.
 */
export const SKIPPED_FILE_PATTERNS = [/\.env/i, /secret/i, /\.pem$/i, /\.key$/i];
export function isSkippedFile(name) {
    return SKIPPED_FILE_PATTERNS.some((re) => re.test(basename(name)));
}
