/**
 * outagekit 0.1.0 - config model for outagekit.json.
 *
 * The manifest is the team's own readiness plan: which vendors are
 * critical, where their status pages live, which runbook covers each
 * one, which fallback channel the team falls back to, who escalates,
 * what the staff announcement says, and how fresh the plan is.
 *
 * Escalation contacts are names + channel TYPES only. Phone numbers
 * and email addresses are rejected at load time and never printed or
 * stored in any output - see validateContactPrivacy().
 */
import { readFileSync } from "node:fs";
export const DEFAULT_THRESHOLDS = {
    fallbackTestMaxDays: 90,
    drillMaxDays: 180,
    mailTimeoutMinHours: 24,
};
export function resolveThresholds(cfg) {
    return { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds ?? {}) };
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
}
/**
 * A phone number or email address hiding in an escalation contact.
 * Names are "On-call lead"; channels are "phone", "sms", "teams".
 * Anything with an "@" or 7+ digits in total (a phone number in any
 * common format: +1-555-123-4567, 555 123 4567, ...) is contact
 * data, not a name or a channel type, and the config is refused.
 */
function hasPhoneDigits(value) {
    return value.replace(/\D/g, "").length >= 7;
}
export function contactHasPrivateData(contact) {
    return (contact.name.includes("@") ||
        contact.channel.includes("@") ||
        hasPhoneDigits(contact.name) ||
        hasPhoneDigits(contact.channel));
}
function validateContactPrivacy(cfg) {
    for (const slot of ["primary", "backup"]) {
        const c = cfg.escalation?.[slot];
        if (!c)
            continue;
        if (!isNonEmptyString(c.name) || !isNonEmptyString(c.channel)) {
            throw new Error(`escalation.${slot} must have a name and a channel (names + channel types only)`);
        }
        if (contactHasPrivateData(c)) {
            throw new Error(`escalation.${slot} must be a name + channel TYPE only - phone numbers and email addresses are never stored or printed`);
        }
    }
}
export function validateConfig(cfg) {
    if (!isRecord(cfg))
        throw new Error("config must be a JSON object");
    if (cfg.version !== 1)
        throw new Error("config version must be 1");
    if (!Array.isArray(cfg.vendors) || cfg.vendors.length === 0) {
        throw new Error("config.vendors must be a non-empty array");
    }
    for (const v of cfg.vendors) {
        if (!isRecord(v) || !isNonEmptyString(v.name)) {
            throw new Error("each vendor needs a non-empty name");
        }
        if (v.criticality !== undefined && !["critical", "important", "optional"].includes(String(v.criticality))) {
            throw new Error(`vendor "${v.name}": criticality must be critical, important or optional`);
        }
        if (v.statusPageUrl !== undefined && !isNonEmptyString(v.statusPageUrl)) {
            throw new Error(`vendor "${v.name}": statusPageUrl must be a non-empty string`);
        }
        if (v.runbook !== undefined && !isNonEmptyString(v.runbook)) {
            throw new Error(`vendor "${v.name}": runbook must be a non-empty string`);
        }
    }
    if (cfg.fallbackChannel !== undefined) {
        if (!isRecord(cfg.fallbackChannel) || !isNonEmptyString(cfg.fallbackChannel.type)) {
            throw new Error("fallbackChannel needs a non-empty type");
        }
    }
    if (cfg.thresholds !== undefined) {
        if (!isRecord(cfg.thresholds))
            throw new Error("thresholds must be an object");
        for (const [k, val] of Object.entries(cfg.thresholds)) {
            if (!(k in DEFAULT_THRESHOLDS))
                throw new Error(`unknown threshold: ${k}`);
            if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
                throw new Error(`threshold ${k} must be a non-negative number`);
            }
        }
    }
    if (cfg.allowlist !== undefined) {
        if (!isRecord(cfg.allowlist))
            throw new Error("allowlist must be an object");
        for (const [k, val] of Object.entries(cfg.allowlist)) {
            if (!Array.isArray(val) || !val.every((p) => typeof p === "string")) {
                throw new Error(`allowlist["${k}"] must be an array of phrase strings`);
            }
        }
    }
    const out = cfg;
    validateContactPrivacy(out);
    return out;
}
export function loadConfigFile(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        throw new Error(`cannot read config file: ${path}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`config is not valid JSON: ${path}`);
    }
    return validateConfig(parsed);
}
