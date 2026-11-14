# Contributing to outagekit

## Ground rules

- outagekit audits readiness only. No live monitoring, no polling, no
  alerting, no paging, no incident orchestration, no auto-remediation,
  no SLA/credit math. If a feature touches those, it belongs in a
  different tool.
- No invented numbers. Verdicts in fixtures and docs are the
  fixture's own, labeled as such. No downtime or savings claims.
- Never read, print or store secret values or env values. Output is
  paths, line numbers and single matched lines only. Escalation
  contacts are names + channel types only - phone numbers and email
  addresses are rejected at load and redacted from evidence.
- All public content is ASCII English only. No em dash - use `-`
  (hyphen). Run `npm run preflight` before opening a PR.
- TypeScript strict, zero runtime dependencies, Node 20+.

## Workflow

```sh
npm install
npm run build     # tsc strict, must be clean
npm run lint      # eslint + prettier, must be clean
npm test          # unit + e2e (50 tests)
npm run test:live # live smoke (npm + GitHub 404 re-checks, status-page HEAD)
npm run preflight # ASCII-only + no-internal-names scan
npm run bench     # audit timing over the demo fixtures
```

## Adding a check

1. Add the rule to `src/audit.ts` (one finding per hit, with file +
   line + severity). Keep the check deterministic and file-driven.
2. Add the rule text to `src/report.ts` and fix guidance to
   `FIX_GUIDANCE` in `src/audit.ts`.
3. Add a fixture case to `examples/` (or extend the existing ones)
   and lock the expected numbers into `test/e2e.test.js`.
4. Update the README checks table and the checks list in `src/cli.ts`
   help if the surface changed.

## Adding a fixture

1. Keep it synthetic: invented company, invented dates, invented
   runbook text. Never copy a real company runbook or announcement.
2. Pin fixture dates against the day the fixture was written and note
   the date in `examples/README.md`; the test suite pins "today"
   with OUTAGEKIT_NOW so results stay deterministic.
3. Lock the expected verdict and finding counts into `test/e2e.test.js`.
