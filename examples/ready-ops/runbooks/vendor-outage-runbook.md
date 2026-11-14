# Vendor outage runbook (shared)

This runbook covers our critical vendors: Microsoft 365 and GitHub.

## Step 1 - Check the vendor status page first

- Microsoft 365: https://status.cloud.microsoft/m365
- GitHub: https://status.github.com

Confirm the scope before doing anything else. If the status page
says the vendor is down, the outage is theirs, not ours.

## Step 2 - Tell staff on the fallback channel

Post the staff announcement from templates/staff-announcement.md
on the fallback channel (SMS). State only the vendor published
cause: {{vendor_cause}}.

## Step 3 - Do not try a local fix

Do not reinstall anything - there is no local fix for a vendor
outage. Do not reset passwords, do not change DNS records, do not
re-create mailboxes. Wait for the vendor.

## Step 4 - Watch and verify

Watch the status page. Our mail timeout window is 48 hours. When
the vendor marks the incident serviceRestored, verify mail flow
and code hosting before announcing recovery to staff.
