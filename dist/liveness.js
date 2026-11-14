const TIMEOUT_MS = 8000;
async function once(url, method) {
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
        if (method === "GET")
            await res.arrayBuffer().catch(() => undefined);
        if (res.status >= 200 && res.status < 400)
            return "ok";
        if ((res.status === 401 || res.status === 403 || res.status === 405) && method === "HEAD") {
            return once(url, "GET");
        }
        return "fail";
    }
    catch {
        return "offline";
    }
    finally {
        clearTimeout(timer);
    }
}
export async function checkHead(url) {
    return once(url, "HEAD");
}
