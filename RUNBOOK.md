# Phase 0 runbook: Duet connector check-in test

Times in the log are UTC. Plan about 2 days for step 1, because Duet checks in every few hours.

## Step 0: finish the Vercel setup (about 3 minutes, one time)

The project is deployed at `https://us-mcp-probe.vercel.app` and the Blob store is connected. Two settings are missing.

1. Open the project in Vercel, then **Settings > Environment Variables**.
2. Add `TOKEN_SECRET`: a long random string, 40 characters or more. Nobody needs to remember it.
3. Add `OWNER_PASSPHRASE`: a passphrase you choose. You type it when an agent connects, and to open the log.
4. Open **Deployments**, click the three dots on the top deployment, and click **Redeploy**.
5. Open `https://us-mcp-probe.vercel.app/health`. It shows `"ok":true` when setup is complete.

## Before you start (one time)

1. The server is deployed at a public HTTPS URL, called `BASE` below. Here `BASE` is `https://us-mcp-probe.vercel.app`.
2. You have the owner passphrase.
3. Open `BASE/probe?key=PASSPHRASE` and keep the tab. This is the evidence log.

## Step 1a: add the connector in Claude (about 3 minutes)

1. In Claude, go to **Settings > Connectors > Add custom connector**.
2. Name: `Us probe`. URL: `BASE/mcp`. Leave the advanced OAuth fields empty.
3. Click **Add**, then **Connect**. A page "Connect to Us probe" opens. Type the passphrase and click **Allow**.
4. In the probe log you see three "auth" rows: client registered, owner approved, token issued.

## Step 1b: does Duet see the connector? (DUET-1)

1. Open Duet and send: `Do you have the Us probe connector? Call us_inbox with agent "duet" and reason "user_asked".`
2. Check the log for a `us_inbox` row with `"reason":"user_asked"`.
   - Row present: DUET-1 passes. Go to 1c.
   - Duet says it has no such tool: DUET-1 fails. Go to "If step 1 fails".

## Step 1c: does a scheduled check-in call it with no prompt? (DUET-4, the main test)

1. Send Duet this one instruction, then stop chatting with Duet:
   `At every check-in from now on, call us_inbox from the Us probe connector with agent "duet" and reason "scheduled_checkin". If a message asks for a reply, answer with us_send to "owner".`
2. On the probe page, use the form to drop a test message (the default text is fine). Write down the time.
3. Do not open or message Duet for at least 12 hours (24 is better). Duet notifications are fine to read, but do not reply.
4. Then open the probe log and look at the `us_inbox` rows after the time in item 2.

| What you see | Result |
|---|---|
| A `us_inbox` row at a time you were not using Duet, and a `us_send` reply to `owner` | **Pass.** Heartbeat design works for Duet. |
| A `us_inbox` row, but no reply | **Partial pass.** Background calls work; replies need a look. |
| No `us_inbox` row until you open Duet again | **Fail.** Background runs cannot reach custom connectors. |

5. Send me a screenshot of the log, or the output of `BASE/probe.json?key=PASSPHRASE`. Also tell me the times you used Duet during the window.

## Step 2: connect a second agent

Use a dot (needs ChatGPT Pro) or Grok Bot, whichever you have.

1. Add `BASE/mcp` as a custom MCP server or connector in that agent, and approve with the passphrase. A new "client registered" row appears with that agent's client name.
2. Ask that agent: `Call us_send to "duet" with text "Hello Duet, reply to dot with the time" and from "dot".`
3. Wait for Duet's next check-in. Pass: a `us_send` from duet to dot appears, and the other agent sees it with `us_inbox`.

## If step 1 fails, try these in order

1. **Zapier MCP bridge.** A Zapier connector that Duet already supports calls the Us probe for it. Tests if Duet runs first-party connectors in the background when it does not run custom ones.
2. **Claude Code Routines.** A scheduled Claude Code routine calls us_inbox and posts results somewhere Duet reads (Gmail, Calendar, Slack).
3. **Duet only when opened.** Us gets Duet replies only when you open Duet. Reply-time screens change.

Each result can change 8 MVP screens: 2.1, 2.3, 2.4, 4.1, 4.2, 4.5, 6.1, and the check-in copy.

## Clean up after the test

Remove the connector in Claude Settings > Connectors, and in the second agent. Delete the deployment or change `TOKEN_SECRET` to log every agent out.
