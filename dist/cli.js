#!/usr/bin/env node
/**
 * outagekit 0.1.0 - audit your vendor-outage readiness from your own runbooks.
 *
 * One command that shows whether your team is ready for your biggest
 * vendor's next bad day. Local, zero-dependency, offline except for
 * the optional status-page liveness check (C2). It never monitors
 * live vendor status, never pages anyone, never claims a vendor is
 * "safe" or "risky" - readiness is the only thing it scores.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { auditDir, exitForVerdict, diffAudits } from "./audit.js";
import { loadConfigFile } from "./config.js";
import { checkHead } from "./liveness.js";
import { renderTable, renderExplain, renderDiff, renderFailingFirst } from "./report.js";
import { runInit, INIT_NEXT_STEPS } from "./init.js";
export const VERSION = "0.1.0";
const HELP = `outagekit ${VERSION} - audit your vendor-outage readiness from your own runbooks.

Usage:
  outagekit init [--dir <dir>]                          scaffold outagekit.json + runbook + template
  outagekit audit <dir> [--config <file>] [--format table|json]
  outagekit check <dir> [--config <file>] [--max-warn N]
  outagekit explain <dir> --check <id>
  outagekit diff --baseline <file> <dir>

audit reports and always exits 0. check is the CI gate: exit 0 READY,
1 GAPS, 2 NOT-READY (or a config error). --max-warn N fails (exit 1)
when the WARN count exceeds N. diff exits 1 when a CRITICAL or HIGH
finding is NEW vs the baseline.
Checks are readiness HEURISTICS over your own files, not risk
measurements. Escalation contacts are names + channel types only.
`;
function fail(msg) {
    console.error(`outagekit: ${msg}`);
    process.exit(2);
}
function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith("--"))
            continue;
        const key = a.slice(2);
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--"))
            fail(`flag --${key} needs a value`);
        flags[key] = next;
        i++;
    }
    return flags;
}
function positional(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) {
            i++; // skip the flag's value
            continue;
        }
        out.push(a);
    }
    return out;
}
/** Test hooks (documented): OUTAGEKIT_NOW pins "today" (YYYY-MM-DD),
 *  OUTAGEKIT_OFFLINE=1 forces the C2 liveness check to UNCHECKED. */
function auditOpts() {
    const nowRaw = process.env.OUTAGEKIT_NOW;
    const now = nowRaw ? new Date(nowRaw + "T00:00:00Z") : new Date();
    if (Number.isNaN(now.getTime()))
        fail(`OUTAGEKIT_NOW is not a date: ${nowRaw}`);
    const headCheck = process.env.OUTAGEKIT_OFFLINE === "1"
        ? async () => "offline"
        : checkHead;
    return { now, headCheck };
}
function loadAuditTarget(dir, configFlag) {
    const absDir = resolve(dir);
    if (!existsSync(absDir))
        fail(`directory not found: ${dir}`);
    const cfgPath = typeof configFlag === "string" ? resolve(configFlag) : join(absDir, "outagekit.json");
    if (!existsSync(cfgPath)) {
        fail(`no outagekit.json found (looked at ${cfgPath}) - run "outagekit init" first`);
    }
    return { dir: absDir, cfgPath };
}
async function runAudit(dir, flags) {
    const { dir: absDir, cfgPath } = loadAuditTarget(dir, flags.config);
    let cfg;
    try {
        cfg = loadConfigFile(cfgPath);
    }
    catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }
    return auditDir(absDir, cfg, VERSION, auditOpts());
}
function loadBaseline(path) {
    if (!existsSync(path))
        fail(`baseline file not found: ${path}`);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        fail(`baseline is not valid JSON: ${path}`);
    }
    const b = parsed;
    if (b.tool !== "outagekit" || !Array.isArray(b.checks)) {
        fail(`baseline is not an outagekit audit result: ${path}`);
    }
    return b;
}
async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];
    if (!cmd || cmd === "--help" || cmd === "-h") {
        console.log(HELP);
        return;
    }
    if (cmd === "--version" || cmd === "-V") {
        console.log(`outagekit ${VERSION}`);
        return;
    }
    if (cmd === "init") {
        const flags = parseFlags(args.slice(1));
        const dir = resolve(typeof flags.dir === "string" ? flags.dir : ".");
        const res = runInit(dir);
        if (res.refused)
            fail(`outagekit.json already exists in ${dir} - refusing to overwrite`);
        console.log(`outagekit init - created in ${dir}:`);
        for (const f of res.created)
            console.log(`  ${f}`);
        console.log(INIT_NEXT_STEPS);
        return;
    }
    if (cmd === "audit") {
        const flags = parseFlags(args.slice(1));
        const pos = positional(args.slice(1));
        if (pos.length !== 1)
            fail("usage: outagekit audit <dir> [--config <file>] [--format table|json]");
        const result = await runAudit(pos[0], flags);
        const format = typeof flags.format === "string" ? flags.format : "table";
        if (format === "json")
            console.log(JSON.stringify(result, null, 2));
        else if (format === "table")
            console.log(renderTable(result));
        else
            fail(`--format must be table or json, got: ${format}`);
        return;
    }
    if (cmd === "check") {
        const flags = parseFlags(args.slice(1));
        const pos = positional(args.slice(1));
        if (pos.length !== 1)
            fail("usage: outagekit check <dir> [--config <file>] [--max-warn N]");
        const result = await runAudit(pos[0], flags);
        console.log(renderFailingFirst(result));
        console.log(`\ncheck: ${result.verdict} (exit ${exitForVerdict(result.verdict)})`);
        let code = exitForVerdict(result.verdict);
        if (typeof flags["max-warn"] === "string") {
            const maxWarn = parseInt(flags["max-warn"], 10);
            if (Number.isNaN(maxWarn) || maxWarn < 0)
                fail("--max-warn must be a non-negative integer");
            if (code === 0 && result.summary.warn > maxWarn) {
                console.log(`check: ${result.summary.warn} WARN findings exceed --max-warn ${maxWarn}`);
                code = 1;
            }
        }
        process.exit(code);
    }
    if (cmd === "explain") {
        const flags = parseFlags(args.slice(1));
        const pos = positional(args.slice(1));
        if (pos.length !== 1 || typeof flags.check !== "string") {
            fail("usage: outagekit explain <dir> --check <id>");
        }
        const result = await runAudit(pos[0], flags);
        console.log(renderExplain(result, flags.check));
        return;
    }
    if (cmd === "diff") {
        const flags = parseFlags(args.slice(1));
        const pos = positional(args.slice(1));
        if (typeof flags.baseline !== "string" || pos.length !== 1) {
            fail("usage: outagekit diff --baseline <file> <dir>");
        }
        const baseline = loadBaseline(flags.baseline);
        const result = await runAudit(pos[0], flags);
        const diff = diffAudits(baseline, result);
        console.log(renderDiff(diff, flags.baseline));
        const newSevere = diff.added.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
        process.exit(newSevere ? 1 : 0);
    }
    fail(`unknown command: ${cmd}\n${HELP}`);
}
main().catch((e) => {
    console.error(`outagekit: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
});
