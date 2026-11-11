// Minimal OAuth 2.1 authorization server for one owner.
// - Dynamic Client Registration (RFC 7591): the client_id is a signed blob that
//   holds the redirect URIs, so no database is needed.
// - Client ID Metadata Documents (CIMD): an https client_id is fetched and its
//   redirect_uris are checked.
// - Authorization code + PKCE (S256 only). Access and refresh tokens are signed
//   blobs (HMAC-SHA256).
// This is a test server. It has one user: the owner who knows OWNER_PASSPHRASE.
import crypto from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import type { Store } from "./store.js";

const SECRET = () => {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error("TOKEN_SECRET must be set (32+ chars)");
  return s;
};
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(kind: string, payload: object): string {
  const body = b64u(JSON.stringify({ k: kind, ...payload }));
  const mac = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T = any>(kind: string, token: string | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p: any;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p.k !== kind) return null;
  if (p.exp && Date.now() / 1000 > p.exp) return null;
  return p as T;
}

const now = () => Math.floor(Date.now() / 1000);

type ClientInfo = { name: string; redirectUris: string[] };

// Resolve a client_id to its allowed redirect URIs.
async function resolveClient(clientId: string): Promise<ClientInfo | null> {
  if (clientId.startsWith("https://") || (process.env.ALLOW_HTTP_CIMD === "1" && clientId.startsWith("http://localhost"))) {
    // CIMD: fetch the client metadata document.
    try {
      const r = await fetch(clientId, { headers: { Accept: "application/json" }, redirect: "error" });
      if (!r.ok) return null;
      const doc: any = await r.json();
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
      return { name: doc.client_name || clientId, redirectUris: doc.redirect_uris };
    } catch {
      return null;
    }
  }
  const p = verify<{ n: string; r: string[] }>("client", clientId);
  return p ? { name: p.n, redirectUris: p.r } : null;
}

export function publicUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  return `${proto}://${req.get("host")}`;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function authRouter(store: Store): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(express.json());

  // RFC 9728 protected resource metadata. Some clients add the resource path.
  const prm = (req: Request, res: Response) => {
    const base = publicUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["us"],
      resource_name: "Us probe",
    });
  };
  r.get("/.well-known/oauth-protected-resource", prm);
  r.get("/.well-known/oauth-protected-resource/mcp", prm);

  // RFC 8414 authorization server metadata (and the OIDC path some clients try).
  const asm = (req: Request, res: Response) => {
    const base = publicUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["us"],
      client_id_metadata_document_supported: true,
    });
  };
  r.get("/.well-known/oauth-authorization-server", asm);
  r.get("/.well-known/oauth-authorization-server/mcp", asm);
  r.get("/.well-known/openid-configuration", asm);

  // RFC 7591 Dynamic Client Registration.
  r.post("/register", async (req, res) => {
    const b = req.body || {};
    const uris: unknown = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" });
    }
    for (const u of uris as string[]) {
      let ok = false;
      try {
        const p = new URL(u);
        ok = p.protocol === "https:" || p.hostname === "localhost" || p.hostname === "127.0.0.1";
      } catch {}
      if (!ok) return res.status(400).json({ error: "invalid_redirect_uri", error_description: u });
    }
    const name = String(b.client_name || "unnamed client").slice(0, 80);
    const clientId = sign("client", { n: name, r: uris, iat: now() });
    await store.addEvent({ at: new Date().toISOString(), kind: "auth", client: name, note: "client registered (DCR)", userAgent: req.get("user-agent") });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // Authorization endpoint: shows a passphrase form to the owner.
  const checkAuthorize = async (q: Record<string, any>) => {
    const client = await resolveClient(String(q.client_id || ""));
    if (!client) return { err: "Unknown client_id." };
    const ru = String(q.redirect_uri || "");
    if (!client.redirectUris.includes(ru)) return { err: "redirect_uri is not registered for this client." };
    if (q.response_type !== "code") return { err: "response_type must be code." };
    if (!q.code_challenge || q.code_challenge_method !== "S256") return { err: "PKCE with S256 is required." };
    return { client, ru };
  };

  r.get("/authorize", async (req, res) => {
    const q = req.query as Record<string, string>;
    const c = await checkAuthorize(q);
    if ("err" in c) return res.status(400).send(page("Cannot connect", `<p>${esc(c.err!)}</p>`));
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource", "response_type"]
      .map((k) => (q[k] ? `<input type="hidden" name="${k}" value="${esc(String(q[k]))}">` : ""))
      .join("");
    res.send(
      page(
        "Connect to Us probe",
        `<p><b>${esc(c.client!.name)}</b> wants to use the Us probe tools (us_inbox, us_send).</p>
         <form method="post" action="/authorize">${hidden}
           <label>Owner passphrase<br><input name="passphrase" type="password" autofocus required></label>
           <button type="submit">Allow</button>
         </form>`
      )
    );
  });

  r.post("/authorize", async (req, res) => {
    const q = req.body as Record<string, string>;
    const c = await checkAuthorize(q);
    if ("err" in c) return res.status(400).send(page("Cannot connect", `<p>${esc(c.err!)}</p>`));
    const want = process.env.OWNER_PASSPHRASE || "";
    const got = String(q.passphrase || "");
    const ok = want.length > 0 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) return res.status(403).send(page("Wrong passphrase", `<p>Go back and try again.</p>`));
    const code = sign("code", {
      c: q.client_id,
      ru: c.ru,
      cc: q.code_challenge,
      res: q.resource || null,
      n: c.client!.name,
      exp: now() + 300,
      j: crypto.randomUUID(),
    });
    await store.addEvent({ at: new Date().toISOString(), kind: "auth", client: c.client!.name, note: "owner approved" });
    const u = new URL(c.ru!);
    u.searchParams.set("code", code);
    if (q.state) u.searchParams.set("state", q.state);
    res.redirect(302, u.toString());
  });

  // Token endpoint.
  r.post("/token", async (req, res) => {
    const b = req.body || {};
    let clientId = b.client_id as string | undefined;
    const basic = req.get("authorization");
    if (!clientId && basic?.startsWith("Basic ")) {
      clientId = decodeURIComponent(Buffer.from(basic.slice(6), "base64").toString().split(":")[0]);
    }
    const fail = (e: string, d: string) => res.status(400).json({ error: e, error_description: d });
    const issue = (cid: string, name: string, base: string) => {
      const access = sign("access", { c: cid, n: name, aud: `${base}/mcp`, exp: now() + 3600 });
      const refresh = sign("refresh", { c: cid, n: name, exp: now() + 30 * 86400, j: crypto.randomUUID() });
      res.set("Cache-Control", "no-store").json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "us" });
    };
    const base = publicUrl(req);

    if (b.grant_type === "authorization_code") {
      const p = verify<any>("code", b.code);
      if (!p) return fail("invalid_grant", "bad or expired code");
      if (clientId && clientId !== p.c) return fail("invalid_grant", "client mismatch");
      if (b.redirect_uri && b.redirect_uri !== p.ru) return fail("invalid_grant", "redirect_uri mismatch");
      const v = String(b.code_verifier || "");
      const cc = crypto.createHash("sha256").update(v).digest("base64url");
      if (!v || cc !== p.cc) return fail("invalid_grant", "PKCE check failed");
      await store.addEvent({ at: new Date().toISOString(), kind: "auth", client: p.n, note: "token issued" });
      return issue(p.c, p.n, base);
    }
    if (b.grant_type === "refresh_token") {
      const p = verify<any>("refresh", b.refresh_token);
      if (!p) return fail("invalid_grant", "bad or expired refresh token");
      if (clientId && clientId !== p.c) return fail("invalid_grant", "client mismatch");
      await store.addEvent({ at: new Date().toISOString(), kind: "auth", client: p.n, note: "token refreshed" });
      return issue(p.c, p.n, base);
    }
    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  return r;
}

export function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1c1c1e;background:#fff}
input{font:inherit;padding:8px;margin:6px 0 12px;width:100%;box-sizing:border-box}button{font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#0a84ff;color:#fff}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}code{font-size:12px}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
