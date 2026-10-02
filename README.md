# kan 勘

A small assistant that runs entirely on your computer, answers from your own notes, and uses only EU-made model weights.

_Kan_ is Japanese for intuition, the gut read. Before kan answers, a small model makes one quick call: are your notes worth using for this question? It shows that call as a thin bar above the answer, so you can see how sure it was.

- **Local.** The models, your notes and the index all stay on your machine. Once the models are downloaded, kan needs no internet.
- **EU weights.** Answers come from Mistral (Paris); note search uses Mixedbread (Berlin). Both are Apache 2.0.
- **Small.** About 2.8 GB of models, and about 4 GB of memory while they run: kan pins the model's context to 8k tokens, which is plenty for notes and a conversation. (Left to Ollama's default, a Mac with lots of memory gives the model its full 262k context and reserves 32 GB for it.) It should fit on a laptop with 8 GB; so far it has only been tested on a Mac with Apple silicon.
- **Quick.** `kan serve` loads the models as it starts and keeps them loaded for 30 minutes after the last question. On the Mac it was built on, the first word of an answer arrives in 60–300 ms.
- **Your notes, read-only.** Point it at any folder of Markdown or text files. It never edits them.

## What's inside

| Part                        | Model                                  | Made by             | Licence    | Size   |
| --------------------------- | -------------------------------------- | ------------------- | ---------- | ------ |
| Answers and the gut read    | Ministral 3 3B, text-only Q4_K_M       | Mistral AI, France  | Apache 2.0 | 2.1 GB |
| Note search (embeddings)    | `mxbai-embed-large`                    | Mixedbread, Germany | Apache 2.0 | 0.7 GB |
| Harder questions (optional) | `ministral-3:8b`                       | Mistral AI, France  | Apache 2.0 | 6.0 GB |

The 3B model comes from [Mistral's own GGUF](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF) rather than Ollama's `ministral-3:3b`. It's the same model without the 0.8 GB part that reads images, which kan never uses. Same answers, a smaller download.

The weights are EU-made. The software they run on isn't all European: [Ollama](https://ollama.com) (MIT) runs the models and [Node.js](https://nodejs.org) runs kan. Both are open source.

## Install

You need [Node.js 24+](https://nodejs.org) and [Ollama](https://ollama.com/download), running.

```bash
git clone https://github.com/pvcomms/kan-eu.git
cd kan-eu
./install.sh            # add --deep for the 8B model
```

The installer downloads Mistral's model file at a fixed commit and refuses it unless its sha256 matches `models.lock`, then builds it into Ollama as `kan-ministral-3b` (`models/ministral-3b.Modelfile`). It pulls the embedding model from Ollama, creates your private `identity/USER.md`, and indexes the example notes.

On Windows, run the same steps by hand: download the GGUF from the URL in `models.lock` into `models/`, run `ollama create kan-ministral-3b -f models/ministral-3b.Modelfile` and `ollama pull mxbai-embed-large`, copy `identity/USER.example.md` to `identity/USER.md`, then use `node src/kan.ts` wherever this README says `./bin/kan`.

## Use

```bash
./bin/kan ask "when should I plant out the tomatoes?" --why
./bin/kan serve          # web page at http://127.0.0.1:6262
```

```
· kan-ministral-3b:latest · notes use 0.91 · 2 found
  use 0.910  ignore 0.090  (187 ms)
According to your notes, plant out your tomatoes after the last frost, around 10 May.
[1] examples/notes/Garden plan 2026.md › Timing  (0.79)
```

| Command          | What it does                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `kan ask "…"`    | Answer, using your notes when they help. `--deep` uses the 8B model; `--notes` / `--no-notes` overrides the gut read; `--why` prints it. |
| `kan search "…"` | Search your notes without asking a model.                                                                                                |
| `kan index`      | Re-index after your notes change. Only changed files are re-read.                                                                        |
| `kan status`     | Which models are installed and how much is indexed.                                                                                      |
| `kan serve`      | The web page, on 127.0.0.1 only.                                                                                                         |

## Your notes

Edit `config/kan.json`:

```json
"sources": [
  { "name": "notes", "dir": "~/Documents/notes" },
  { "name": "journal", "dir": "~/journal", "exclude": ["drafts"] }
]
```

Then run `./bin/kan index`. Hidden files and folders are skipped. Delete the `examples` entry once your own notes are in.

Write a few lines about yourself in `identity/USER.md`; kan reads it on every message. `identity/SOUL.md` sets how kan answers. Both are plain text, and git ignores `USER.md`.

## How the gut read works

kan searches your notes first, so the small model decides with the evidence in front of it.

1. If no note is even close (similarity under 0.55), kan skips your notes.
2. Otherwise Ministral is shown your question and the three closest notes, and asked to pick A (use) or B (ignore). It generates one token. Ollama returns that token's probabilities, kan reads the two letters', and that pair is the bar.
3. Nothing is written, so the decision can't ramble or fall outside the two options. It takes 20–150 ms on the Mac it was built on.

When the model is unsure, kan leans towards using the notes. An unneeded note costs a little context; a missing one costs a wrong answer.

Measured on the 13 questions in `eval/notes-set.jsonl` (8 about the example notes, 5 not): 13/13 use-or-ignore calls right, and the right note found first every time. That's a small test on easy notes, so treat it as a smoke test rather than a benchmark. Run `node eval/notes.ts`, and write your own `notes-set.jsonl` to test against your notes.

## Privacy

- kan's web server listens on 127.0.0.1 only. It rejects requests from other websites, checking both the Host and Origin headers.
- Only `ollama pull` touches the internet. Asking questions is entirely local.
- **About Ollama itself:** recent builds also contact `ollama.com` in the background on their own (model recommendations and web features). To stop that:
  - set `OLLAMA_NO_CLOUD=1` in Ollama's environment, which disables cloud models;
  - block `ollama.com` at the network level, for example a `127.0.0.1 ollama.com` line in `/etc/hosts`. On macOS use `127.0.0.1`: `0.0.0.0` doesn't block anything there.

  Model downloads come from `registry.ollama.ai`, which is a different host, so `ollama pull` keeps working.

- Your index lives in `data/memory.db`. Delete the folder to forget everything.

## Limits

- A 3B model gets things wrong. kan cites which notes it used so you can check, but it won't always cite them inline.
- No voice, no tools, no web search. It reads your notes and answers.
- Conversation history lasts for one browser tab and isn't saved.

## Licence

The code is MIT. The fonts (Newsreader, IBM Plex Mono) are SIL Open Font License 1.1; see `web/fonts/`. The models aren't in this repository: `install.sh` downloads them from Mistral's Hugging Face repository and the Ollama registry, under their own Apache 2.0 licences.
