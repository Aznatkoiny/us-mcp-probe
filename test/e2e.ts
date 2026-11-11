// End-to-end test: discovery, DCR, CIMD, authorize, PKCE, token, refresh, MCP tools.
import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.TOKEN_SECRET = "test-secret-test-secret-test-secret-123";
process.env.OWNER_PASSPHRASE = "pass-phrase";
process.env.DATA_FILE = `./data/test-${Date.now()}.json`;
process.env.ALLOW_HTTP_CIMD = "1";
const { app } = await import("../src/app.js");
const srv = app.listen(0);
const base = `http://localhost:${(srv.address() as any).port}`;
const CB = "https://claude.ai/api/mcp/auth_callback";
let pass = 0;
const ok = (m: string) => { pass++; console.log("ok -", m); };

// 1. Unauthenticated MCP call gets 401 with resource metadata pointer.
let r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(r.status, 401);
const wa = r.headers.get("www-authenticate")!;
assert.match(wa, /resource_metadata="/);
ok("401 with WWW-Authenticate resource_metadata");

// 2. Discovery.
const prm = await (await fetch(wa.match(/resource_metadata="([^"]+)"/)![1])).json();
assert.equal(prm.resource, `${base}/mcp`);
const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes("S256"));
assert.equal(asm.client_id_metadata_document_supported, true);
ok("protected resource + authorization server metadata");

// 3. DCR.
r = await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) });
assert.equal(r.status, 201);
const reg = await r.json();
ok("dynamic client registration");
r = await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
assert.equal(r.status, 400);
ok("DCR rejects non-https redirect");

async function authorize(clientId: string, redirect: string, passphrase = "pass-phrase") {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = { client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${base}/mcp`, scope: "us" };
  const g = await fetch(`${asm.authorization_endpoint}?${new URLSearchParams(params)}`);
  assert.equal(g.status, 200);
  assert.match(await g.text(), /passphrase/);
  const p = await fetch(asm.authorization_endpoint, { method: "POST", redirect: "manual", body: new URLSearchParams({ ...params, passphrase }) });
  return { p, verifier };
}

// 4. Wrong passphrase is refused.
assert.equal((await authorize(reg.client_id, CB, "nope")).p.status, 403);
ok("wrong passphrase refused");
// Unregistered redirect is refused.
const bad = await fetch(`${asm.authorization_endpoint}?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: "x", code_challenge_method: "S256" })}`);
assert.equal(bad.status, 400);
ok("unregistered redirect_uri refused");

// 5. Good flow + PKCE.
const { p, verifier } = await authorize(reg.client_id, CB);
assert.equal(p.status, 302);
const loc = new URL(p.headers.get("location")!);
assert.equal(loc.origin + loc.pathname, CB);
assert.equal(loc.searchParams.get("state"), "xyz");
const code = loc.searchParams.get("code")!;
r = await fetch(asm.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong", client_id: reg.client_id, redirect_uri: CB }) });
assert.equal(r.status, 400);
ok("PKCE mismatch refused");
r = await fetch(asm.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CB }) });
assert.equal(r.status, 200);
let tok = await r.json();
assert.ok(tok.access_token && tok.refresh_token);
ok("code exchanged for tokens");
r = await fetch(asm.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) });
assert.equal(r.status, 200);
tok = await r.json();
ok("refresh token works");

// 6. MCP over Streamable HTTP with the token.
const client = new Client({ name: "e2e-duet-sim", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
const tools = await client.listTools();
assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["us_inbox", "us_send"]);
ok("tools listed: us_inbox, us_send");
let res: any = await client.callTool({ name: "us_inbox", arguments: { agent: "duet", reason: "scheduled_checkin" } });
assert.match(res.content[0].text, /No messages/);
await fetch(`${base}/probe`, { method: "POST", body: new URLSearchParams({ key: "pass-phrase", to: "*", text: "hello from probe" }), redirect: "manual" });
res = await client.callTool({ name: "us_inbox", arguments: { agent: "duet", reason: "scheduled_checkin" } });
assert.match(res.content[0].text, /hello from probe/);
ok("us_inbox returns the owner's probe message");
res = await client.callTool({ name: "us_send", arguments: { to: "owner", from: "duet", text: "saw it" } });
assert.match(res.content[0].text, /Sent/);
ok("us_send stores a reply");
await client.close();

// 7. CIMD client (local http allowed only in tests).
const cimd = http.createServer((_q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ client_id: cimdUrl, client_name: "CIMD client", redirect_uris: [CB] })); }).listen(0);
const cimdUrl = `http://localhost:${(cimd.address() as any).port}/client.json`;
const c2 = await authorize(cimdUrl, CB);
assert.equal(c2.p.status, 302);
ok("CIMD client_id accepted");
cimd.close();

// 8. Probe log shows the evidence.
const log = await (await fetch(`${base}/probe.json?key=pass-phrase`)).json();
const inboxCalls = log.events.filter((e: any) => e.tool === "us_inbox");
assert.equal(inboxCalls.length, 2);
assert.equal(inboxCalls[0].args.reason, "scheduled_checkin");
assert.ok(log.events.some((e: any) => e.kind === "initialize" && e.clientInfo?.name === "e2e-duet-sim"));
assert.equal((await fetch(`${base}/probe.json?key=wrong-pass!`)).status, 403);
ok("probe log records initialize clientInfo, tool calls, reasons; key required");

srv.close();
console.log(`\n${pass} checks passed`);
process.exit(0);
