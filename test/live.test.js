/**
 * Live smoke tests for outagekit (run with `npm run test:live`).
 *
 * 1. npm name `outagekit` is still free (404).
 * 2. GitHub org repo techdevfun/outagekit is still free (404).
 * 3. The status-page HEAD liveness check answers for a real status
 *    page (soft-skips when offline - a network failure is not a
 *    product failure).
 *
 * A 403/429 from the registry or GitHub is a rate-limit answer, not
 * evidence the name is taken: those skip instead of failing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkHead } from "../dist/liveness.js";

async function getStatus(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    return res.status;
  } catch {
    return null; // offline
  }
}

test("live: npm package name outagekit is free (404)", async (t) => {
  const status = await getStatus("https://registry.npmjs.org/outagekit");
  if (status === null) {
    t.skip("offline - cannot check the npm registry");
    return;
  }
  if (status === 403 || status === 429) {
    t.skip(`registry rate-limited (${status}) - inconclusive`);
    return;
  }
  assert.equal(status, 404, `expected npm 404 for outagekit, got ${status}`);
});

test("live: GitHub repo techdevfun/outagekit is free (404)", async (t) => {
  const status = await getStatus("https://api.github.com/repos/techdevfun/outagekit");
  if (status === null) {
    t.skip("offline - cannot check GitHub");
    return;
  }
  if (status === 403 || status === 429) {
    t.skip(`GitHub rate-limited (${status}) - inconclusive`);
    return;
  }
  assert.equal(status, 404, `expected GitHub 404 for techdevfun/outagekit, got ${status}`);
});

test("live: status-page HEAD check answers for a real status page", async (t) => {
  const res = await checkHead("https://status.stripe.com");
  if (res === "offline") {
    t.skip("offline - liveness check cannot run");
    return;
  }
  assert.equal(res, "ok", `expected ok for status.stripe.com, got ${res}`);
});
