// System One: one typed decision with a probability for every option.
//
// Options are labelled A, B, C… and the model is asked for a single token.
// Ollama returns the top-20 log-probabilities for that token; we read the
// ones for our labels and softmax over just those. No text is generated, so
// the answer can't fall outside the declared options.

import { RUNTIME } from "./ollama.ts";

export type Decision = {
  value: string;
  p: number;
  distribution: Record<string, number>;
  ms: number;
};

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FLOOR = -30; // a label outside the top 20 is treated as near-impossible

export async function decide(
  ollama: string,
  model: string,
  state: string,
  question: string,
  options: string[],
  hints: Record<string, string> = {},
): Promise<Decision> {
  if (options.length < 2 || options.length > LABELS.length)
    throw new Error(`2..${LABELS.length} options`);
  const t0 = Date.now();
  const list = options
    .map((o, i) => `${LABELS[i]}) ${o}${hints[o] ? `: ${hints[o]}` : ""}`)
    .join("\n");

  const res = await fetch(`${ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      logprobs: true,
      top_logprobs: 20,
      keep_alive: RUNTIME.keep_alive,
      options: { num_predict: 1, temperature: 0, num_ctx: RUNTIME.num_ctx },
      messages: [
        {
          role: "system",
          content:
            "You make one decision. Reply with only the letter of one option, nothing else.",
        },
        {
          role: "user",
          content: `${state}\n\n---\n${question}\n\nOptions:\n${list}\n\nAnswer with one letter.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`system1 ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    logprobs?: { top_logprobs: { token: string; logprob: number }[] }[];
  };
  const top = data.logprobs?.[0]?.top_logprobs;
  if (!top)
    throw new Error("this Ollama build returns no logprobs; update Ollama");

  const lp = options.map((_, i) =>
    Math.max(
      FLOOR,
      ...top
        .filter((t) => t.token.trim().replace(/[).:]/g, "") === LABELS[i])
        .map((t) => t.logprob),
    ),
  );
  const max = Math.max(...lp);
  const exp = lp.map((x) => Math.exp(x - max));
  const z = exp.reduce((a, b) => a + b, 0);
  const distribution = Object.fromEntries(
    options.map((o, i) => [o, exp[i] / z]),
  );
  const value = options[exp.indexOf(Math.max(...exp))];
  return { value, p: distribution[value], distribution, ms: Date.now() - t0 };
}
