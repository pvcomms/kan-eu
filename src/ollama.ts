// Minimal Ollama client: installed models + streaming chat.

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
    body: JSON.stringify({ model, messages, stream: true, think }),
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
