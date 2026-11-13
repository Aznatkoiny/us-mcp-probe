// Storage for the probe log and the test inbox.
// Local runs use a JSON file. A hosted run can use Upstash Redis (REST) so the
// data survives restarts and works on serverless hosts.
import fs from "node:fs";
import path from "node:path";
import { get, put } from "@vercel/blob";

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

// Vercel Blob (private): one JSON file, updated with ETag checks so two
// requests at the same time do not lose a write.
type Doc = { events: ProbeEvent[]; messages: InboxMessage[] };
class BlobStore implements Store {
  private key = "probe/probe.json";
  private async load(): Promise<{ doc: Doc; etag?: string }> {
    const r = await get(this.key, { access: "private", useCache: false });
    if (!r || !r.stream) return { doc: { events: [], messages: [] } };
    const text = await new Response(r.stream).text();
    return { doc: JSON.parse(text), etag: r.blob.etag };
  }
  private async update(fn: (d: Doc) => void) {
    for (let i = 0; i < 5; i++) {
      const { doc, etag } = await this.load();
      fn(doc);
      try {
        await put(this.key, JSON.stringify(doc), {
          access: "private",
          addRandomSuffix: false,
          contentType: "application/json",
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return;
      } catch (e) {
        if (i === 4) throw e;
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
      }
    }
  }
  async addEvent(e: ProbeEvent) {
    await this.update((d) => { d.events.unshift(e); d.events = d.events.slice(0, 2000); });
  }
  async events(limit = 500) { return (await this.load()).doc.events.slice(0, limit); }
  async addMessage(m: InboxMessage) {
    await this.update((d) => { d.messages.unshift(m); d.messages = d.messages.slice(0, 500); });
  }
  async messages(limit = 100) { return (await this.load()).doc.messages.slice(0, limit); }
}

export function makeStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobStore();
  // On a read-only host (serverless with no store connected) use the temp
  // folder, so the server still starts. That data does not last.
  const file = process.env.DATA_FILE || (process.env.VERCEL ? "/tmp/us-probe/probe.json" : "./data/probe.json");
  return new FileStore(file);
}

export function storeKind(): "redis" | "blob" | "file" {
  if ((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) return "redis";
  return process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "file";
}
