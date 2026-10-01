// Notes eval over examples/notes: does recall() use notes when it should,
// is the right note among what it keeps, and how close is each top hit.
//   node eval/notes.ts          (run `kan index` first)
// Point it at your own notes by writing your own eval/notes-set.jsonl.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig } from "../src/core.ts";
import { open } from "../src/memory.ts";
import { recall } from "../src/recall.ts";

const cfg = loadConfig();
const rows = readFileSync(join(ROOT, "eval/notes-set.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { message: string; expect: string | null });
const db = open(ROOT, cfg.memory);

let decided = 0, found = 0, pos = 0;
for (const r of rows) {
  const rc = await recall(db, cfg.ollama, cfg.system1, cfg.memory, r.message);
  const want = r.expect !== null;
  if (rc.use === want) decided++;
  let line = `${rc.use === want ? "ok  " : "MISS"} ${rc.use ? "use   " : "ignore"} closest ${(rc.top ?? 0).toFixed(2)}`;
  if (want) {
    pos++;
    const hit = rc.hits.find((h) => h.path.endsWith(r.expect!));
    if (hit) found++;
    line += hit ? `  found @${hit.n}` : "  NOT FOUND";
  }
  console.log(`${line}  ${r.message}`);
}
db.close();
console.log(`\nuse/ignore ${decided}/${rows.length} · right note kept ${found}/${pos}`);
