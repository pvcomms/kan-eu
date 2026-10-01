// Should this message use your notes? Search first, then decide with the
// evidence in hand. A small model can't tell from the message alone whether
// a question is about you; shown the closest notes, it can. A cheap score
// gate skips the decision when nothing in your notes is close.

import type { DatabaseSync } from "node:sqlite";
import { decide, type Decision } from "./system1.ts";
import { search, type Hit, type MemoryConfig } from "./memory.ts";

export type RecallConfig = MemoryConfig & {
  gate: number;
  question: string;
  threshold: number;
  hints: Record<string, string>;
};

export type Recall = {
  use: boolean;
  hits: Hit[];
  top: number | null;
  decision?: Decision;
  note: string;
};

export async function recall(
  db: DatabaseSync,
  ollama: string,
  model: string,
  cfg: RecallConfig,
  message: string,
): Promise<Recall> {
  const hits = await search(db, ollama, { ...cfg, min_score: 0 }, message);
  const top = hits[0]?.score ?? 0;
  if (top < cfg.gate)
    return {
      use: false,
      hits: [],
      top,
      note: `notes no (closest ${top.toFixed(2)} < ${cfg.gate})`,
    };

  const evidence = hits
    .slice(0, 3)
    .map((h) => `- ${h.heading}: ${h.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const state = `Message: ${message}\n\nCandidate notes:\n${evidence}`;
  try {
    const d = await decide(
      ollama,
      model,
      state,
      cfg.question,
      Object.keys(cfg.hints),
      cfg.hints,
    );
    const use = d.distribution.use >= cfg.threshold;
    const kept = use ? hits.filter((h) => h.score >= cfg.min_score) : [];
    return {
      use,
      hits: kept,
      top,
      decision: d,
      note: `notes ${use ? "use" : "ignore"} ${d.distribution.use.toFixed(2)}`,
    };
  } catch {
    const kept = hits.filter((h) => h.score >= cfg.min_score);
    return {
      use: true,
      hits: kept,
      top,
      note: "notes use (decision unavailable)",
    };
  }
}
