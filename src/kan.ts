// kan — a small, local, EU-weights assistant over your own notes.
//
//   kan ask "message" [--deep] [--notes|--no-notes] [--why]
//   kan search "query"           search your notes (no model answer)
//   kan index [-v]               (re)index your notes, incremental
//   kan status                   models + index
//   kan serve                    web UI on 127.0.0.1:6262

import { ROOT, loadConfig, turn } from "./core.ts";
import { installed } from "./ollama.ts";
import { display, index, open, search } from "./memory.ts";

const cfg = loadConfig();
const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s: string) => process.stderr.write(dim(s + "\n"));

async function ask(
  message: string,
  deep: boolean,
  notes: boolean | undefined,
  why: boolean,
): Promise<void> {
  let sources: { n: number; path: string; heading: string; score: number }[] =
    [];
  let modelLine = "";
  await turn(cfg, { message, deep, notes }, (e) => {
    if (e.type === "model") modelLine = `· ${e.model}`;
    else if (e.type === "notes") {
      sources = e.sources;
      say(
        `${modelLine} · ${e.note}${e.use ? ` · ${e.sources.length} found` : ""}`,
      );
      if (why && e.decision) {
        const d = Object.entries(e.decision.distribution).map(
          ([k, p]) => `${k} ${p.toFixed(3)}`,
        );
        say(`  ${d.join("  ")}  (${e.decision.ms} ms)`);
      }
    } else if (e.type === "token") process.stdout.write(e.t);
    else if (e.type === "done") {
      process.stdout.write("\n");
      for (const s of sources) {
        const head = s.heading.split(" › ").slice(1).join(" › ");
        say(
          `[${s.n}] ${display(s.path)}${head ? ` › ${head}` : ""}  (${s.score.toFixed(2)})`,
        );
      }
    }
  });
}

async function status(): Promise<void> {
  const have = await installed(cfg.ollama).catch(() => null);
  if (!have) {
    console.log(`ollama   DOWN  ${cfg.ollama} — start Ollama first`);
    return;
  }
  const row = (label: string, model: string, note = "") =>
    console.log(
      `${label.padEnd(8)} ${have.has(model) || have.has(`${model}:latest`) ? "ok     " : "MISSING"} ${model}${note}`,
    );
  row("fast", cfg.models.fast.model);
  row("deep", cfg.models.deep.model, "  (optional, for --deep)");
  row("embed", cfg.memory.embed);
  const db = open(ROOT, cfg.memory);
  const rows = db
    .prepare("SELECT source, COUNT(*) n FROM chunks GROUP BY source")
    .all() as { source: string; n: number }[];
  db.close();
  console.log(
    `notes    ${rows.map((r) => `${r.source} ${r.n} chunks`).join(", ") || "empty — run kan index"}`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const take = (f: string) => {
  const i = rest.indexOf(f);
  if (i >= 0) rest.splice(i, 1);
  return i >= 0;
};

try {
  if (cmd === "ask") {
    const why = take("--why");
    const deep = take("--deep");
    const notes = take("--notes")
      ? true
      : take("--no-notes")
        ? false
        : undefined;
    const message = rest.join(" ").trim();
    if (!message) throw new Error('usage: kan ask "message"');
    await ask(message, deep, notes, why);
  } else if (cmd === "search") {
    const q = rest.join(" ").trim();
    if (!q) throw new Error('usage: kan search "query"');
    const db = open(ROOT, cfg.memory);
    const hits = await search(db, cfg.ollama, cfg.memory, q, 10);
    db.close();
    for (const h of hits) {
      console.log(
        `[${h.n}] ${h.score.toFixed(2)}  ${display(h.path)}\n    ${h.heading}\n    ${h.text.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    if (!hits.length) console.log("nothing close enough");
  } else if (cmd === "index") {
    const db = open(ROOT, cfg.memory);
    const t0 = Date.now();
    const s = await index(
      db,
      ROOT,
      cfg.ollama,
      cfg.memory,
      take("-v") ? say : () => {},
    );
    db.close();
    say(
      `· +${s.added} ~${s.updated} -${s.removed} =${s.unchanged} notes · ${s.chunks} chunks embedded · ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
  } else if (cmd === "status") {
    await status();
  } else if (cmd === "serve") {
    await import("./server.ts");
  } else {
    console.log(
      'kan ask "message" [--deep] [--notes|--no-notes] [--why]\n' +
        'kan search "query"\nkan index [-v]\nkan status\nkan serve',
    );
  }
} catch (e) {
  process.stderr.write(`kan: ${(e as Error).message}\n`);
  process.exit(1);
}
