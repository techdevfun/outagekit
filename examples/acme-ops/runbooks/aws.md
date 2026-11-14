# Vendor outage runbook - AWS

Step 1: Check the vendor status page first:
https://status.aws.amazon.com

Step 2: Confirm the scope in the AWS Health Dashboard. If the
affected region is ours, note which services are listed.

Step 3: Post the staff announcement from
templates/staff-announcement.md on the fallback channel (SMS).
State only the vendor published cause: {{vendor_cause}}.

Step 4: Do not reinstall anything - there is no local fix for a
vendor outage. Shift traffic only if the runbook for that service
has a tested failover step.

Step 5: Watch the status page. Our mail timeout window is 48 hours.
