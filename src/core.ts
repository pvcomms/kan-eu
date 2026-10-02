// One turn of kan, shared by the CLI and the web server. Emits events as it
// goes so each surface can render the notes decision and tokens live.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chat, installed, type Message } from "./ollama.ts";
import { open, search, type Hit } from "./memory.ts";
import { recall, type RecallConfig } from "./recall.ts";
import type { Decision } from "./system1.ts";

export type Model = { model: string; think?: boolean | string };
export type Config = {
  ollama: string;
  models: { fast: Model; deep: Model };
  system1: string;
  identity: string[];
  memory: RecallConfig;
};

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const loadConfig = (): Config =>
  JSON.parse(readFileSync(join(ROOT, "config/kan.json"), "utf8"));

export type Source = {
  n: number;
  path: string;
  heading: string;
  score: number;
};
export type Event =
  | { type: "model"; name: "fast" | "deep"; model: string }
  | {
      type: "notes";
      use: boolean;
      note: string;
      decision: Decision | null;
      sources: Source[];
    }
  | { type: "thinking" }
  | { type: "token"; t: string }
  | { type: "done"; ms: number };

export type TurnInput = {
  message: string;
  history?: Message[];
  deep?: boolean;
  notes?: boolean;
};

function systemPrompt(cfg: Config, hits: Hit[]): string {
  const parts: string[] = [];
  for (const f of cfg.identity) {
    try {
      parts.push(readFileSync(join(ROOT, f), "utf8").trim());
    } catch {
      // identity/USER.md is optional; install.sh creates it from the example
    }
  }
  const now = new Date();
  parts.push(
    `Today is ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ` +
      `${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} local time.`,
  );
  if (hits.length) {
    const notes = hits
      .map((h) => `[${h.n}] ${h.heading}\n${h.text}`)
      .join("\n\n");
    parts.push(
      `# The user's notes (retrieved for this message)\n\n${notes}\n\n` +
        `Answer from these notes where they apply and cite them inline as [1], [2]. ` +
        `If they don't contain the answer, say so in one line ("Not in your notes."), then answer from general ` +
        `knowledge if you can, clearly as general knowledge. Never present general knowledge as something from their notes.`,
    );
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

export async function turn(
  cfg: Config,
  input: TurnInput,
  emit: (e: Event) => void,
): Promise<string> {
  const t0 = Date.now();
  const { message, history = [] } = input;

  const have = await installed(cfg.ollama);
  let name: "fast" | "deep" = input.deep ? "deep" : "fast";
  if (name === "deep" && !have.has(cfg.models.deep.model)) name = "fast";
  const m = cfg.models[name];
  if (!have.has(m.model))
    throw new Error(
      `${m.model} isn't installed. Run ./install.sh${name === "deep" ? " --deep" : ""}`,
    );
  emit({ type: "model", name, model: m.model });

  const db = open(ROOT, cfg.memory);
  const n =
    input.notes === false
      ? {
          use: false,
          hits: [] as Hit[],
          decision: undefined,
          note: "notes off",
        }
      : input.notes === true
        ? {
            use: true,
            hits: await search(db, cfg.ollama, cfg.memory, message),
            decision: undefined,
            note: "notes on",
          }
        : await recall(db, cfg.ollama, cfg.system1, cfg.memory, message);
  db.close();
  const sources: Source[] = n.hits.map((h) => ({
    n: h.n,
    path: h.path,
    heading: h.heading,
    score: h.score,
  }));
  emit({
    type: "notes",
    use: n.use,
    note: n.note,
    decision: n.decision ?? null,
    sources,
  });

  const answer = await chat(
    cfg.ollama,
    m.model,
    [
      { role: "system", content: systemPrompt(cfg, n.hits) },
      ...history,
      { role: "user", content: message },
    ],
    (t) => emit({ type: "token", t }),
    m.think ?? false,
    () => emit({ type: "thinking" }),
  );
  emit({ type: "done", ms: Date.now() - t0 });
  return answer;
}
