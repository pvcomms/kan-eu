// kan web: binds 127.0.0.1 only. Serves web/ and a small JSON/NDJSON API.
// Host and Origin are checked on every request so a page on another site
// can't reach this server through your browser (DNS rebinding / CSRF).

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ROOT, loadConfig, turn, type Event } from "./core.ts";
import { installed } from "./ollama.ts";
import { display } from "./memory.ts";

const cfg = loadConfig();
const PORT = Number(process.env.KAN_PORT ?? 6262);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const WEB = join(ROOT, "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};
const MAX_BODY = 1024 * 1024;

async function body(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  if (path === "/api/status" && req.method === "GET") {
    const have = await installed(cfg.ollama).catch(() => null);
    return json(res, 200, {
      ollama: have !== null,
      fast: have?.has(cfg.models.fast.model) ?? false,
      deep: have?.has(cfg.models.deep.model) ?? false,
      models: { fast: cfg.models.fast.model, deep: cfg.models.deep.model },
    });
  }

  if (path === "/api/ask" && req.method === "POST") {
    const input = JSON.parse(await body(req));
    if (typeof input.message !== "string" || !input.message.trim())
      return json(res, 400, { error: "message required" });
    const history = Array.isArray(input.history)
      ? input.history
          .filter(
            (m: { role?: string; content?: unknown }) =>
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string",
          )
          .slice(-12)
      : [];
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    });
    const send = (e: Event | { type: "error"; error: string }) => {
      if (e.type === "notes")
        e = {
          ...e,
          sources: e.sources.map((s) => ({ ...s, path: display(s.path) })),
        };
      res.write(JSON.stringify(e) + "\n");
    };
    try {
      await turn(
        cfg,
        {
          message: input.message.trim(),
          history,
          deep: input.deep === true,
          notes: input.notes,
        },
        send,
      );
    } catch (e) {
      send({ type: "error", error: (e as Error).message });
    }
    return void res.end();
  }

  return json(res, 404, { error: "not found" });
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const file = join(WEB, normalize(path === "/" ? "/index.html" : path));
  if (!file.startsWith(WEB + "/"))
    return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:",
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

createServer(async (req, res) => {
  if (!HOSTS.has(req.headers.host ?? ""))
    return json(res, 403, { error: "bad host" });
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && !ORIGINS.has(origin))
    return json(res, 403, { error: "bad origin" });
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  try {
    if (path.startsWith("/api/")) await api(req, res, path);
    else if (req.method === "GET") await serveStatic(res, path);
    else json(res, 405, { error: "method not allowed" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    else res.end();
  }
}).listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`kan · http://127.0.0.1:${PORT}\n`);
});
