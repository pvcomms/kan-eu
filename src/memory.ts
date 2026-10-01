// Memory: a read-only index over folders of Markdown notes.
//
// Notes are only ever read. The index lives in data/memory.db.
// Embeddings come from Ollama and are unit-normalised, so cosine = dot.
// Search is brute force over Float32Arrays: a few thousand chunks take
// milliseconds, and it avoids shipping a native vector extension.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME } from "./ollama.ts";

export type Source = { name: string; dir: string; exclude?: string[] };
export type MemoryConfig = {
  db: string;
  embed: string;
  query_prefix: string;
  doc_prefix: string;
  k: number;
  min_score: number;
  sources: Source[];
};
export type Hit = {
  n: number;
  score: number;
  source: string;
  path: string;
  heading: string;
  text: string;
};

type Doc = { path: string; source: string; text: string; title: string };

const CHUNK = 1200;
const BATCH = 32;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function resolveDir(root: string, p: string): string {
  const expanded = p.replace(/^~(?=\/|$)/, homedir());
  return isAbsolute(expanded) ? expanded : join(root, expanded);
}

export function open(root: string, cfg: MemoryConfig): DatabaseSync {
  const file = join(root, cfg.db);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, source TEXT, hash TEXT, indexed_at TEXT);
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY, path TEXT, source TEXT, heading TEXT, text TEXT, emb BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

// ---- reading notes (read-only) ----

function walk(
  dir: string,
  exclude: string[],
  out: string[] = [],
  base = dir,
): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full);
    if (name.startsWith(".") || exclude.some((x) => rel.startsWith(x)))
      continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exclude, out, base);
    else if (name.endsWith(".md") || name.endsWith(".txt")) out.push(full);
  }
  return out;
}

function readSource(root: string, s: Source): Doc[] {
  const dir = resolveDir(root, s.dir);
  return walk(dir, s.exclude ?? []).map((f) => ({
    path: f,
    source: s.name,
    text: readFileSync(f, "utf8"),
    title: relative(dir, f).replace(/\.(md|txt)$/, ""),
  }));
}

// ---- chunking: split on headings, pack paragraphs up to CHUNK chars ----

export function chunk(doc: Doc): { heading: string; text: string }[] {
  const body = doc.text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const out: { heading: string; text: string }[] = [];
  let heading = doc.title;
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ heading, text: t });
    buf = "";
  };
  for (const para of body.split(/\n{2,}/)) {
    const h = para.match(/^#{1,6}\s+(.+)/);
    if (h) {
      flush();
      heading = `${doc.title} › ${h[1].trim()}`;
    }
    if (buf.length + para.length > CHUNK) flush();
    if (para.length > CHUNK) {
      for (let i = 0; i < para.length; i += CHUNK)
        out.push({ heading, text: para.slice(i, i + CHUNK) });
    } else buf += para + "\n\n";
  }
  flush();
  return out;
}

// ---- embeddings ----

async function embed(
  base: string,
  model: string,
  inputs: string[],
): Promise<Float32Array[]> {
  const res = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: inputs,
      truncate: true,
      keep_alive: RUNTIME.keep_alive,
    }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const { embeddings } = (await res.json()) as { embeddings: number[][] };
  return embeddings.map((e) => {
    const v = Float32Array.from(e);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  });
}

// ---- index (incremental by content hash) ----

export async function index(
  db: DatabaseSync,
  root: string,
  ollama: string,
  cfg: MemoryConfig,
  log: (s: string) => void,
): Promise<{
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunks: number;
}> {
  const stats = { added: 0, updated: 0, removed: 0, unchanged: 0, chunks: 0 };

  // a different embedding model makes old vectors meaningless: start over
  const prev = (
    db.prepare("SELECT value FROM meta WHERE key = 'embed'").get() as
      { value: string } | undefined
  )?.value;
  if (prev && prev !== cfg.embed) {
    log(
      `embedding model changed (${prev} → ${cfg.embed}); rebuilding the index`,
    );
    db.exec("DELETE FROM chunks; DELETE FROM docs;");
  }
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('embed', ?)",
  ).run(cfg.embed);

  const known = new Map(
    (
      db.prepare("SELECT path, hash FROM docs").all() as {
        path: string;
        hash: string;
      }[]
    ).map((r) => [r.path, r.hash]),
  );
  const seen = new Set<string>();
  const insChunk = db.prepare(
    "INSERT INTO chunks (path, source, heading, text, emb) VALUES (?, ?, ?, ?, ?)",
  );
  const upDoc = db.prepare(
    "INSERT OR REPLACE INTO docs (path, source, hash, indexed_at) VALUES (?, ?, ?, ?)",
  );
  const delChunks = db.prepare("DELETE FROM chunks WHERE path = ?");

  for (const src of cfg.sources) {
    if (!existsSync(resolveDir(root, src.dir))) {
      log(`skip ${src.name}: ${src.dir} not found`);
      continue;
    }
    for (const doc of readSource(root, src)) {
      seen.add(doc.path);
      const h = sha(doc.text);
      const before = known.get(doc.path);
      if (before === h) {
        stats.unchanged++;
        continue;
      }
      const pieces = chunk(doc);
      const vecs: Float32Array[] = [];
      for (let i = 0; i < pieces.length; i += BATCH) {
        const batch = pieces
          .slice(i, i + BATCH)
          .map((c) => `${cfg.doc_prefix}${c.heading}\n${c.text}`);
        vecs.push(...(await embed(ollama, cfg.embed, batch)));
      }
      db.exec("BEGIN");
      delChunks.run(doc.path);
      pieces.forEach((c, i) =>
        insChunk.run(
          doc.path,
          doc.source,
          c.heading,
          c.text,
          new Uint8Array(vecs[i].buffer),
        ),
      );
      upDoc.run(doc.path, doc.source, h, new Date().toISOString());
      db.exec("COMMIT");
      stats.chunks += pieces.length;
      before ? stats.updated++ : stats.added++;
      log(
        `${before ? "updated" : "added  "} ${doc.source}: ${doc.title} (${pieces.length})`,
      );
    }
  }
  for (const path of known.keys()) {
    if (seen.has(path)) continue;
    delChunks.run(path);
    db.prepare("DELETE FROM docs WHERE path = ?").run(path);
    stats.removed++;
    log(`removed ${path}`);
  }
  return stats;
}

// ---- search ----

export async function search(
  db: DatabaseSync,
  ollama: string,
  cfg: MemoryConfig,
  query: string,
  k = cfg.k,
): Promise<Hit[]> {
  const [q] = await embed(ollama, cfg.embed, [`${cfg.query_prefix}${query}`]);
  const rows = db
    .prepare("SELECT path, source, heading, text, emb FROM chunks")
    .all() as {
    path: string;
    source: string;
    heading: string;
    text: string;
    emb: Uint8Array;
  }[];
  const scored = rows.map((r) => {
    const v = new Float32Array(
      r.emb.buffer,
      r.emb.byteOffset,
      r.emb.byteLength / 4,
    );
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    return { ...r, score: s };
  });
  const perPath = new Map<string, number>();
  return scored
    .filter((r) => r.score >= cfg.min_score)
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      // at most two passages per file, so k slots cover more than one note
      const c = perPath.get(r.path) ?? 0;
      perPath.set(r.path, c + 1);
      return c < 2;
    })
    .slice(0, k)
    .map((r, i) => ({
      n: i + 1,
      score: r.score,
      source: r.source,
      path: r.path,
      heading: r.heading,
      text: r.text,
    }));
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export function display(path: string): string {
  if (path.startsWith(REPO + "/")) return relative(REPO, path);
  return path.startsWith(homedir()) ? "~" + path.slice(homedir().length) : path;
}
