/**
 * outagekit init - scaffold a starter readiness plan.
 *
 * The scaffold is a CORRECT example: it passes C3-C5 and C8-C9 out
 * of the box, so the golden path (init -> audit -> check) starts
 * from READY and the team edits from a passing plan instead of
 * debugging a broken one. Dates are written as today, so the
 * freshness checks start green and go stale on their real schedule.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}
const MANIFEST_TEMPLATE = (today) => `{
  "version": 1,
  "vendors": [
    {
      "name": "Microsoft 365",
      "statusPageUrl": "https://status.cloud.microsoft/m365",
      "runbook": "runbooks/microsoft-365.md",
      "criticality": "critical"
    }
  ],
  "fallbackChannel": {
    "type": "sms",
    "name": "SMS broadcast group",
    "lastTested": "${today}"
  },
  "escalation": {
    "primary": { "name": "On-call lead", "channel": "phone" },
    "backup": { "name": "Duty manager", "channel": "sms" }
  },
  "commsTemplate": "templates/staff-announcement.md",
  "mailTimeoutHours": 48,
  "lastDrill": "${today}",
  "thresholds": {
    "fallbackTestMaxDays": 90,
    "drillMaxDays": 180,
    "mailTimeoutMinHours": 24
  }
}
`;
const RUNBOOK_TEMPLATE = `# Vendor outage runbook - Microsoft 365

Step 1: Check the vendor status page first:
https://status.cloud.microsoft/m365

Step 2: Confirm the scope in the Microsoft 365 admin center
(Service health) if it loads. If it does not load, that is part of
the outage - do not treat it as a second incident.

Step 3: Post the staff announcement from
templates/staff-announcement.md on the fallback channel (SMS).
State only the vendor published cause: {{vendor_cause}}.

Step 4: Do not reinstall anything - there is no local fix for a
vendor outage. Do not reset passwords, do not change DNS records,
do not re-create mailboxes. Wait for the vendor.

Step 5: Watch the status page. Mail sent during the outage is held
by the retry window: our mail timeout window is 48 hours.

Step 6: When the vendor marks the incident serviceRestored, verify
mail flow and Teams before announcing recovery to staff.
`;
const TEMPLATE_TEMPLATE = `# Staff announcement - vendor outage

Subject: [Vendor outage] {{vendor_name}} is down - what to do

We are affected by an outage at our vendor {{vendor_name}}.
The vendor published cause is: {{vendor_cause}}.

What this means for you:
- Email and chat through the vendor may be delayed or unavailable.
- Use the fallback channel (SMS) for urgent messages until further notice.
- Do not reinstall apps or reset passwords - this is a vendor outage
  and there is no local fix.

We will update this notice when the vendor publishes its next update.
`;
export function runInit(dir) {
    const manifestPath = join(dir, "outagekit.json");
    if (existsSync(manifestPath)) {
        return { created: [], refused: true };
    }
    const today = todayIso();
    mkdirSync(join(dir, "runbooks"), { recursive: true });
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(manifestPath, MANIFEST_TEMPLATE(today));
    writeFileSync(join(dir, "runbooks", "microsoft-365.md"), RUNBOOK_TEMPLATE);
    writeFileSync(join(dir, "templates", "staff-announcement.md"), TEMPLATE_TEMPLATE);
    return {
        created: ["outagekit.json", "runbooks/microsoft-365.md", "templates/staff-announcement.md"],
        refused: false,
    };
}
export const INIT_NEXT_STEPS = `next steps:
  1. Edit outagekit.json: add your critical vendors, fallback channel, escalation contacts.
  2. Run: outagekit audit .     (report - always exits 0)
  3. Run: outagekit check .     (CI gate - exit 0 READY, 1 GAPS, 2 NOT-READY)`;
