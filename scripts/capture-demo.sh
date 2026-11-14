#!/usr/bin/env bash
# Capture the demo transcript from the REAL CLI (no hand-edited output).
# Runs in a scratch dir so nothing pollutes the repo. The transcript is
# rendered to demo/outagekit-demo.gif by scripts/make-gif.py.
#
# Both fixtures are SYNTHETIC (invented company names, dates and
# runbook text); their verdicts are the fixtures' own, not
# measurements of any real company. "Today" is pinned to 2026-11-14
# (the day the fixtures were written) so the freshness checks score
# the same way every time this script runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH=/tmp/outagekit-demo
BIN="$SCRATCH/bin"
rm -rf "$SCRATCH"
mkdir -p "$BIN" "$ROOT/demo"
ln -sf "$ROOT/dist/cli.js" "$BIN/outagekit"
chmod +x "$ROOT/dist/cli.js"
export PATH="$BIN:$PATH"
export OUTAGEKIT_NOW=2026-11-14

WORK="$SCRATCH/work"
mkdir -p "$WORK"
cd "$WORK"

OUT="$ROOT/demo/transcript.txt"
{
  echo "# outagekit demo - real CLI output on the SYNTHETIC fixtures"
  echo "# (acme-ops: a team with gaps; ready-ops: a team that is ready."
  echo "#  Verdicts are the fixtures' own, not measurements of any real"
  echo "#  company. Freshness is scored against 2026-11-14.)"
  echo ""
  echo "\$ outagekit init"
  outagekit init --dir "$WORK"
  cd "$ROOT"
  echo ""
  echo "\$ outagekit audit examples/acme-ops"
  outagekit audit examples/acme-ops
  echo ""
  echo "\$ outagekit explain examples/acme-ops --check C5"
  outagekit explain examples/acme-ops --check C5
  echo ""
  echo "\$ outagekit check examples/acme-ops"
  outagekit check examples/acme-ops || echo "exit: $?"
  echo ""
  echo "\$ outagekit audit examples/ready-ops"
  outagekit audit examples/ready-ops
  echo ""
  echo "\$ outagekit check examples/ready-ops"
  outagekit check examples/ready-ops || echo "exit: $?"
} > "$OUT" 2>&1
echo "transcript written: $OUT ($(wc -l < "$OUT") lines)"
