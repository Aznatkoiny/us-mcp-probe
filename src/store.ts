// Storage for the probe log and the test inbox.
// Local runs use a JSON file. A hosted run can use Upstash Redis (REST) so the
// data survives restarts and works on serverless hosts.
import fs from "node:fs";
import path from "node:path";

export type ProbeEvent = {
  at: string; // ISO time (UTC)
  kind: string; // "initialize" | "tool" | "auth" | "http"
  tool?: string;
  client?: string; // client_name from registration, or CIMD URL
  clientInfo?: unknown; // MCP clientInfo from initialize
  userAgent?: string;
  args?: unknown;
  note?: string;
};

export type InboxMessage = {
  id: string;
  at: string;
  from: string;
  to: string; // agent name, or "*" for any agent
  text: string;
  thread?: string;
};

export interface Store {
  addEvent(e: ProbeEvent): Promise<void>;
  events(limit?: number): Promise<ProbeEvent[]>;
  addMessage(m: InboxMessage): Promise<void>;
  messages(limit?: number): Promise<InboxMessage[]>;
}

class FileStore implements Store {
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ events: [], messages: [] }));
  }
  private read(): { events: ProbeEvent[]; messages: InboxMessage[] } {
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }
  private write(d: { events: ProbeEvent[]; messages: InboxMessage[] }) {
    fs.writeFileSync(this.file, JSON.stringify(d, null, 1));
  }
  async addEvent(e: ProbeEvent) {
    const d = this.read();
    d.events.unshift(e);
    d.events = d.events.slice(0, 2000);
    this.write(d);
  }
  async events(limit = 500) {
    return this.read().events.slice(0, limit);
  }
  async addMessage(m: InboxMessage) {
    const d = this.read();
    d.messages.unshift(m);
    d.messages = d.messages.slice(0, 500);
    this.write(d);
  }
  async messages(limit = 100) {
    return this.read().messages.slice(0, limit);
  }
}

class UpstashStore implements Store {
  constructor(private url: string, private token: string) {}
  private async cmd(args: (string | number)[]) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`upstash ${r.status}`);
    return (await r.json()).result;
  }
  async addEvent(e: ProbeEvent) {
    await this.cmd(["LPUSH", "probe:events", JSON.stringify(e)]);
    await this.cmd(["LTRIM", "probe:events", 0, 1999]);
  }
  async events(limit = 500) {
    const r: string[] = await this.cmd(["LRANGE", "probe:events", 0, limit - 1]);
    return r.map((s) => JSON.parse(s));
  }
  async addMessage(m: InboxMessage) {
    await this.cmd(["LPUSH", "probe:messages", JSON.stringify(m)]);
    await this.cmd(["LTRIM", "probe:messages", 0, 499]);
  }
  async messages(limit = 100) {
    const r: string[] = await this.cmd(["LRANGE", "probe:messages", 0, limit - 1]);
    return r.map((s) => JSON.parse(s));
  }
}

export function makeStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  return new FileStore(process.env.DATA_FILE || "./data/probe.json");
}
