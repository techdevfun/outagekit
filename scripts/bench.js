/**
 * Bench: time `audit` over the two demo fixtures (liveness skipped),
 * 200 runs. Prints median + p95. Run 3 times and take the median of
 * the medians for the README number. Target: p95 < 2 s on the demo
 * fixture set.
 */
import { auditDir } from "../dist/audit.js";
import { loadConfigFile } from "../dist/config.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [join(ROOT, "examples", "acme-ops"), join(ROOT, "examples", "ready-ops")];
const NOW = new Date("2026-11-14T00:00:00Z");
const OFFLINE = async () => "offline";

function quantile(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

const samples = [];
for (let i = 0; i < 200; i++) {
  const t0 = performance.now();
  for (const d of dirs) {
    const cfg = loadConfigFile(join(d, "outagekit.json"));
    await auditDir(d, cfg, "0.1.0", { now: NOW, headCheck: OFFLINE });
  }
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
console.log(
  `audit over 2 demo fixtures (200 runs): median ${quantile(samples, 0.5).toFixed(2)} ms, p95 ${quantile(samples, 0.95).toFixed(2)} ms, max ${samples[samples.length - 1].toFixed(2)} ms`,
);
