// kan web client. No dependencies. Talks only to its own origin.

const $ = (s, el = document) => el.querySelector(s);

const thread = $("#thread");
const empty = $("#empty");
const form = $("#composer");
const input = $("#input");
const send = $("#send");
const health = $("#health");
const deepBtn = $("#deep-btn");
const tpl = $("#turn-tpl");

const state = { history: [], deep: false, notes: "", busy: false, seq: 0 };

// ---------- small safe markdown: escape first, then format ----------

const esc = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inline(s, fn) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(
      /\[(\d{1,2})\]/g,
      (_, n) => `<sup><a href="#${fn}-${n}">${n}</a></sup>`,
    );
}

function markdown(src, fn) {
  // escape first, then format line by line: lists may follow a heading or a
  // paragraph in the same block, so group consecutive lines by kind
  const out = [];
  const parts = esc(src).split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${part.replace(/\n$/, "")}</code></pre>`);
      return;
    }
    let para = [];
    let list = null; // { tag, items }
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join("<br>"), fn)}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x, fn)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    for (const raw of part.split("\n")) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (!line.trim()) {
        flushPara();
        flushList();
      } else if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (h) {
        flushPara();
        flushList();
        out.push(`<h3>${inline(h[1], fn)}</h3>`);
      } else if (list && /^\s{2,}\S/.test(raw)) {
        list.items[list.items.length - 1] += " " + line.trim(); // wrapped list item
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  });
  return out.join("");
}

// ---------- health: only speak up when something is off ----------

async function checkHealth() {
  try {
    const s = await (await fetch("/api/status")).json();
    const problems = [];
    if (!s.ollama)
      problems.push("Ollama isn't running. Start it, then reload.");
    else if (!s.fast)
      problems.push(`${esc(s.models.fast)} isn't installed. Run ./install.sh`);
    deepBtn.disabled = !s.deep;
    deepBtn.title = s.deep
      ? ""
      : `Install ${s.models.deep} to use deep: ./install.sh --deep`;
    health.innerHTML = problems.join("<br>");
    health.hidden = problems.length === 0;
  } catch {
    health.textContent = "kan's server isn't reachable.";
    health.hidden = false;
  }
}

// ---------- turns ----------

function gut(el, e) {
  const box = $(".gut", el);
  const line = $(".gut-line", box);
  const d = e.decision;
  if (d) {
    $(".use", box).style.flexGrow = String(Math.max(d.distribution.use, 0.02));
    $(".ignore", box).style.flexGrow = String(
      Math.max(d.distribution.ignore, 0.02),
    );
    const n = e.sources.length;
    line.innerHTML = e.use
      ? `used ${n} note${n === 1 ? "" : "s"} · sure <span class="num">${d.distribution.use.toFixed(2)}</span>`
      : `left notes out · sure <span class="num">${d.distribution.ignore.toFixed(2)}</span>`;
    box.hidden = false;
  } else if (e.use && e.sources.length) {
    $(".bar", box).hidden = true;
    line.textContent = `used ${e.sources.length} notes`;
    box.hidden = false;
  }
}

function footnotes(el, sources, fn) {
  const ol = $(".sources", el);
  ol.innerHTML = sources
    .map((s) => {
      const [file, ...rest] = s.heading.split(" › ");
      const head = rest.length
        ? ` <span class="head">› ${esc(rest.join(" › "))}</span>`
        : "";
      return `<li id="${fn}-${s.n}"><span class="n">${s.n}</span><span class="where">${esc(file)}${head}</span><span class="score">${s.score.toFixed(2)}</span></li>`;
    })
    .join("");
  ol.hidden = sources.length === 0;
}

async function ask(message) {
  if (state.busy || !message.trim()) return;
  state.busy = true;
  send.disabled = true;
  empty.hidden = true;

  const fn = `t${++state.seq}`;
  const el = tpl.content.firstElementChild.cloneNode(true);
  $(".asked", el).textContent = message;
  const answerEl = $(".answer", el);
  answerEl.classList.add("waiting");
  thread.append(el);
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  let answer = "";
  let model = "";
  let frame = 0;
  const paint = () => {
    frame = 0;
    answerEl.innerHTML = markdown(answer, fn);
  };

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: state.history.slice(-12),
        deep: state.deep,
        notes: state.notes === "" ? undefined : state.notes === "true",
      }),
    });
    if (!res.ok || !res.body) throw new Error(`server ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === "model") model = e.model;
        else if (e.type === "notes") {
          gut(el, e);
          footnotes(el, e.sources, fn);
        } else if (e.type === "thinking") answerEl.dataset.state = "thinking";
        else if (e.type === "token") {
          answer += e.t;
          answerEl.classList.remove("waiting");
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (e.type === "done") {
          const meta = $(".meta", el);
          meta.textContent = `${model} · ${(e.ms / 1000).toFixed(1)} s`;
          meta.hidden = false;
        } else if (e.type === "error") throw new Error(e.error);
      }
    }
    if (frame) cancelAnimationFrame(frame);
    paint();
    state.history.push(
      { role: "user", content: message },
      { role: "assistant", content: answer },
    );
  } catch (err) {
    answerEl.classList.remove("waiting");
    answerEl.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    state.busy = false;
    send.disabled = false;
    input.focus();
  }
}

// ---------- wiring ----------

function resize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

input.addEventListener("input", resize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = input.value;
  input.value = "";
  resize();
  ask(msg);
});

for (const group of document.querySelectorAll(".choice")) {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    for (const b of group.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b === btn));
    if ("deep" in btn.dataset) state.deep = btn.dataset.deep === "true";
    if ("notes" in btn.dataset) state.notes = btn.dataset.notes;
  });
}

checkHealth();
setInterval(checkHealth, 15000);
input.focus();
