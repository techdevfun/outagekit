/**
 * Status-page liveness (check C2).
 *
 * A HEAD request is enough for most status pages, but not all of them:
 * Microsoft's status page answers HEAD with 401 and GET with 200
 * (verified 2026-11-14), so a HEAD-only check would report the
 * flagship vendor's page as down when it is up. When HEAD is refused
 * (401/403/405) we retry with GET and discard the body. Redirects are
 * followed (AWS status answers 301 to its health dashboard).
 *
 * Any network error, DNS failure or timeout is "offline": the check
 * reports UNCHECKED, never PASS and never FAIL. A live check that
 * cannot run must not fail a suite or a gate.
 */
export type HeadResult = "ok" | "fail" | "offline";

const TIMEOUT_MS = 8000;

async function once(url: string, method: "HEAD" | "GET"): Promise<HeadResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": "outagekit/0.1.0 (readiness audit)" },
    });
    // Drain a GET body so the connection closes cleanly; the body is
    // never stored or inspected.
    if (method === "GET") await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 400) return "ok";
    if ((res.status === 401 || res.status === 403 || res.status === 405) && method === "HEAD") {
      return once(url, "GET");
    }
    return "fail";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHead(url: string): Promise<HeadResult> {
  return once(url, "HEAD");
}
