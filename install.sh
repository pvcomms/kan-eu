#!/bin/bash
# kan installer: checks Node and Ollama, pulls the EU models, indexes the
# example notes. Re-run it any time; it skips what's already done.
#   ./install.sh          fast model + embeddings (~3.7 GB)
#   ./install.sh --deep   also the 8B model for harder questions (+6 GB)
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '%s\n' "$*"; }
fail() { printf 'kan: %s\n' "$*" >&2; exit 1; }

# --- Node 24+ (runs the TypeScript directly and has SQLite built in) ---
command -v node >/dev/null || fail "Node.js 24 or newer is required: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || fail "Node.js 24 or newer is required (you have $(node -v))"

# --- Ollama, running locally ---
command -v ollama >/dev/null || fail "Ollama is required: https://ollama.com/download"
OLLAMA=${OLLAMA_HOST:-127.0.0.1:11434}
curl -sf "http://${OLLAMA#http://}/api/version" >/dev/null || fail "Ollama isn't running. Start it (open the app, or: ollama serve), then re-run."

models=(ministral-3:3b mxbai-embed-large:latest)
[ "${1:-}" = "--deep" ] && models+=(ministral-3:8b)

# --- pull, then check each against the tested build ---
for m in "${models[@]}"; do
  say "· pulling $m"
  ollama pull "$m"
  want=$(awk -v m="$m" '$1==m {sub("sha256:","",$2); print $2}' models.lock)
  have=$(ollama list | awk -v m="$m" '$1==m {print $2}')
  if [ -n "$want" ] && [ "${want:0:12}" != "$have" ]; then
    say "  note: $m is a newer build ($have) than the one kan was tested with (${want:0:12})"
  fi
done

# --- your profile: a private copy git ignores ---
[ -f identity/USER.md ] || { cp identity/USER.example.md identity/USER.md; say "· created identity/USER.md: write a few lines about yourself there"; }

# --- index the example notes so it works straight away ---
./bin/kan index

say ""
say "Done. Try:"
say "  ./bin/kan ask \"when should I plant out the tomatoes?\" --why"
say "  ./bin/kan serve        then open http://127.0.0.1:6262"
say ""
say "To use your own notes, edit memory.sources in config/kan.json, then run ./bin/kan index"
