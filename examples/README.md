# Examples

Two synthetic fixtures so you can see a team with gaps and a team
that is ready, side by side. Both are invented: company names,
vendors, dates and runbook text are made up to show the rules.
Their verdicts are the fixtures' own, not measurements of any real
company.

## acme-ops - gaps (verdict GAPS, exit 1)

- Vendors: Microsoft 365 (critical) + AWS (critical) + Stripe
  (important, no status page configured).
- `outagekit audit examples/acme-ops` - GAPS: 8 HIGH, 3 WARN.
- `outagekit check examples/acme-ops` - exit 1.
- What is wrong: the Microsoft 365 runbook never links the status
  page in its first steps (C4), tells the team to reinstall Outlook
  and re-create the mailbox (C5), the fallback SMS channel was last
  tested 200 days ago (C6), primary and backup escalation share one
  channel (C7), the staff template asserts its own cause and has no
  {{vendor_cause}} placeholder (C8), and the last drill was 197 days
  ago (C10).

## ready-ops - ready (verdict READY, exit 0)

- Vendors: Microsoft 365 (critical) + GitHub (critical), covered
  by one shared runbook that names both status pages in step 1.
- `outagekit audit examples/ready-ops` - READY: 0 HIGH, 0 CRITICAL.
- `outagekit check examples/ready-ops` - exit 0.
- What is right: status pages linked in step 1, no local-fix steps,
  SMS fallback tested 4 days ago, escalation on two channels,
  template states only the vendor published cause, mail timeout
  48 hours, drill 25 days ago.

## Dates

Fixture dates are written against 14 November 2026 (the day the
fixtures were made). Freshness checks (C6, C10) score age against
today, so the fixtures go stale on their real schedule - that is
the point of the checks. The test suite pins "today" to
2026-11-14 with OUTAGEKIT_NOW so results stay deterministic.
