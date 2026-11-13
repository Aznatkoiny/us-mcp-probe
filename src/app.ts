// Us probe: a small stateless Streamable HTTP MCP server for the Phase 0 test.
// It answers one question: does an always-on agent (Claude Duet first) call
// us_inbox on its own, during a scheduled check-in, with no prompt from the owner?
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { authRouter, page, publicUrl, verify } from "./auth.js";
import { makeStore, storeKind, type InboxMessage, type Store } from "./store.js";

const store: Store = makeStore();
const iso = () => new Date().toISOString();

function buildMcp(client: string, userAgent: string | undefined) {
  const server = new McpServer({ name: "us-probe", version: "0.1.0" });

  server.registerTool(
    "us_inbox",
    {
      title: "Check the Us inbox",
      description:
        "Check the Us inbox for new messages from the owner's other agents and from people. " +
        "Call this at every scheduled check-in, even if nobody asked you to. " +
        "Set `reason` to say why you are calling now.",
      inputSchema: {
        agent: z.string().describe("Your own agent name, for example 'duet', 'dot', 'grok'").optional(),
        reason: z
          .enum(["scheduled_checkin", "user_asked", "follow_up", "other"])
          .describe("Why you are checking now")
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ agent, reason }) => {
      await store.addEvent({ at: iso(), kind: "tool", tool: "us_inbox", client, userAgent, args: { agent, reason } });
      const me = (agent || "").toLowerCase();
      const msgs = (await store.messages(50)).filter((m) => m.to === "*" || !me || m.to.toLowerCase() === me).slice(0, 10);
      const lines = msgs.length
        ? msgs.map((m) => `- [${m.at}] from ${m.from} (id ${m.id}${m.thread ? `, thread ${m.thread}` : ""}): ${m.text}`).join("\n")
        : "No messages.";
      return {
        content: [
          {
            type: "text",
            text: `Us inbox at ${iso()} (${msgs.length} message(s)):\n${lines}\n\nIf a message asks for a reply, answer it with us_send.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "us_send",
    {
      title: "Send an Us message",
      description: "Send a message to one of the owner's other agents or to a person, through Us.",
      inputSchema: {
        to: z.string().describe("Who gets the message, for example 'owner', 'dot', 'grok'"),
        text: z.string().max(4000).describe("The message"),
        from: z.string().describe("Your own agent name").optional(),
        thread: z.string().describe("Thread or message id you are answering").optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ to, text, from, thread }) => {
      const m: InboxMessage = { id: crypto.randomUUID().slice(0, 8), at: iso(), from: from || client, to, text, thread };
      await store.addMessage(m);
      await store.addEvent({ at: iso(), kind: "tool", tool: "us_send", client, userAgent, args: { to, from, thread, text: text.slice(0, 300) } });
      return { content: [{ type: "text", text: `Sent (id ${m.id}) to ${to}.` }] };
    }
  );

  return server;
}

export const app = express();
app.set("trust proxy", true);

// Setup check. It shows which settings are present, never their values.
const setup = () => {
  const missing: string[] = [];
  if (!process.env.TOKEN_SECRET || process.env.TOKEN_SECRET.length < 32) missing.push("TOKEN_SECRET (32+ characters)");
  if (!process.env.OWNER_PASSPHRASE) missing.push("OWNER_PASSPHRASE");
  if (process.env.VERCEL && storeKind() === "file") missing.push("a Blob store connected to the project (BLOB_READ_WRITE_TOKEN)");
  return { ok: missing.length === 0, missing, storage: storeKind() };
};
app.get("/health", (_req, res) => {
  const s = setup();
  res.status(s.ok ? 200 : 503).json(s);
});
app.use((req, res, next) => {
  const s = setup();
  if (s.ok || req.path === "/") return next();
  res.status(503).json({ error: "setup_incomplete", missing: s.missing });
});
app.use(authRouter(store));

const mcpHandler = async (req: Request, res: Response) => {
  const base = publicUrl(req);
  const h = req.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? verify<any>("access", h.slice(7)) : null;
  if (!tok || tok.aud !== `${base}/mcp`) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: "invalid_token" });
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    return;
  }
  const ua = req.get("user-agent");
  const body = req.body;
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (m?.method === "initialize") {
      await store.addEvent({ at: iso(), kind: "initialize", client: tok.n, clientInfo: m.params?.clientInfo, userAgent: ua });
    }
  }
  const server = buildMcp(tok.n, ua);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
};
app.all("/mcp", express.json({ limit: "1mb" }), mcpHandler);

// Owner pages: the probe log and a form to drop a test message in the inbox.
const ownerOk = (req: Request) => {
  const want = process.env.OWNER_PASSPHRASE || "";
  const got = String(req.query.key || req.body?.key || "");
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

app.get("/probe", async (req, res) => {
  if (!ownerOk(req)) return res.status(403).send(page("Us probe", "<p>Add ?key=YOUR_PASSPHRASE to the URL.</p>"));
  const ev = await store.events(300);
  const msgs = await store.messages(30);
  const rows = ev
    .map(
      (e) =>
        `<tr><td><code>${esc(e.at)}</code></td><td>${esc(e.kind)}${e.tool ? ` <b>${esc(e.tool)}</b>` : ""}</td><td>${esc(e.client || "")}</td><td><code>${esc(
          JSON.stringify(e.args ?? e.clientInfo ?? e.note ?? "")
        )}</code></td><td><code>${esc(e.userAgent || "")}</code></td></tr>`
    )
    .join("");
  const mrows = msgs.map((m) => `<tr><td><code>${esc(m.at)}</code></td><td>${esc(m.from)} → ${esc(m.to)}</td><td>${esc(m.text)}</td></tr>`).join("");
  res.send(
    page(
      "Us probe log",
      `<p>Times are UTC. A <b>us_inbox</b> row at a time you were not chatting with the agent is the result we want.</p>
       <form method="post" action="/probe"><input type="hidden" name="key" value="${esc(String(req.query.key))}">
       <label>Drop a test message in the inbox (to: agent name or *)<br><input name="to" value="*"></label>
       <input name="text" value="Probe ${new Date().toISOString().slice(0, 16)}Z: please reply with us_send to 'owner' and say what time you saw this." >
       <button>Add message</button></form>
       <h2>Events</h2><table><tr><th>Time</th><th>What</th><th>Client</th><th>Details</th><th>User agent</th></tr>${rows}</table>
       <h2>Messages</h2><table>${mrows}</table>`
    )
  );
});
app.post("/probe", express.urlencoded({ extended: false }), async (req, res) => {
  if (!ownerOk(req)) return res.status(403).send("forbidden");
  await store.addMessage({ id: crypto.randomUUID().slice(0, 8), at: iso(), from: "owner", to: String(req.body.to || "*"), text: String(req.body.text || "") });
  res.redirect(303, `/probe?key=${encodeURIComponent(String(req.body.key))}`);
});
app.get("/probe.json", async (req, res) => {
  if (!ownerOk(req)) return res.status(403).json({ error: "forbidden" });
  res.json({ events: await store.events(1000), messages: await store.messages(100) });
});

app.get("/", (_req, res) => {
  const s = setup();
  const state = s.ok
    ? "<p>Setup is complete.</p>"
    : `<p><b>Setup is not complete.</b> Missing in the Vercel project settings:</p><ul>${s.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul><p>Add them, then redeploy.</p>`;
  res.send(page("Us probe", `<p>Test MCP server for the Us app. MCP endpoint: <code>/mcp</code>.</p>${state}`));
});

// Vercel uses this file as the entry point and needs a default export.
export default app;
