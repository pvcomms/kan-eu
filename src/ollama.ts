// Minimal Ollama client: installed models + streaming chat.

// Every request for the chat model uses the same settings, so Ollama never
// reloads it between the notes decision and the answer. num_ctx matters most:
// left unset, a big-memory Mac gives Ministral its full 262k context and
// reserves 32 GB; 8k is plenty for kan (longest prompt ~2.5k tokens) and
// takes 3.3 GB. keep_alive holds it between questions instead of Ollama's 5 min.
export const RUNTIME = { num_ctx: 8192, keep_alive: "30m" };

// Load the models in the background so the first question doesn't wait.
export function warm(base: string, model: string, embed: string): void {
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  post("/api/generate", { model, keep_alive: RUNTIME.keep_alive, options: { num_ctx: RUNTIME.num_ctx } });
  post("/api/embed", { model: embed, input: "", keep_alive: RUNTIME.keep_alive });
}

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function installed(base: string): Promise<Set<string>> {
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const { models } = (await res.json()) as { models: { name: string }[] };
  return new Set(models.map((m) => m.name));
}

export async function chat(
  base: string,
  model: string,
  messages: Message[],
  onToken: (t: string) => void,
  think: boolean | string = false,
  onThinking: () => void = () => {},
): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      think,
      keep_alive: RUNTIME.keep_alive,
      options: { num_ctx: RUNTIME.num_ctx },
    }),
  });
  if (!res.ok || !res.body)
    throw new Error(`ollama ${res.status}: ${await res.text()}`);

  let out = "";
  let thought = false;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`ollama: ${msg.error}`);
      if (msg.message?.thinking && !thought) {
        thought = true;
        onThinking();
      }
      const t: string = msg.message?.content ?? "";
      if (t) {
        out += t;
        onToken(t);
      }
    }
  }
  return out;
}
