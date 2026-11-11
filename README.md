# us-mcp-probe

Phase 0 test server for the Us app. It is not the app.

It answers one question: **does Claude Duet call an MCP tool on its own, during a scheduled check-in, with no prompt from the owner?** (Assumptions DUET-1 and DUET-4.) After that, it checks that a second agent (a dot or Grok Bot) can use the same server.

## What it has

- Stateless Streamable HTTP MCP endpoint at `/mcp` (POST only, JSON responses, no sessions).
- Two tools:
  - `us_inbox(agent?, reason?)`: returns test messages. The tool description tells the agent to call it at every scheduled check-in, and to set `reason` (`scheduled_checkin`, `user_asked`, `follow_up`, `other`).
  - `us_send(to, text, from?, thread?)`: stores a message (for example a reply to `owner`, or a message to `dot`).
- OAuth 2.1 for one owner:
  - Discovery: `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414).
  - Dynamic Client Registration at `/register` (RFC 7591).
  - Client ID Metadata Documents: an `https://` client_id is fetched and checked.
  - Authorization code with PKCE (S256 only). The consent page asks for the owner passphrase.
  - Access tokens (1 hour) and refresh tokens (30 days) are HMAC-signed. No database is needed for auth.
- Owner pages (need `?key=OWNER_PASSPHRASE`):
  - `/probe`: the evidence log (every `initialize`, tool call, and auth step, with UTC time, client name, MCP clientInfo and user agent) and a form to drop a test message in the inbox.
  - `/probe.json`: the same data as JSON.

## Run locally

```bash
npm install
npm test                      # 14 end-to-end checks: OAuth, DCR, CIMD, PKCE, refresh, tools, log
TOKEN_SECRET=$(openssl rand -hex 32) OWNER_PASSPHRASE=choose-one npm run dev
```

## Environment

| Name | Needed | What |
|---|---|---|
| `TOKEN_SECRET` | yes | 32+ random characters. Signs client IDs, codes and tokens. Changing it logs every agent out. |
| `OWNER_PASSPHRASE` | yes | Typed on the consent page and used as `?key=` for `/probe`. |
| `PUBLIC_URL` | on a host | For example `https://us-probe.vercel.app`. Without it the server uses the request host. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | on serverless | Keeps the log and inbox. `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work. Without them the server writes `./data/probe.json`, which serverless hosts lose. |

## Deploy

Vercel picks up `src/index.ts` (it exports the Express app). Add the env vars above and an Upstash Redis store from the Vercel Marketplace (free tier). Any Node host with a disk (Render, Fly, Railway) also works with no Redis.

## Limits (test server only)

One owner, no user accounts, codes are not one-time (they expire in 5 minutes), no rate limits, no token revocation. Do not reuse this auth code in the real hub.

See `RUNBOOK.md` for the test steps.
