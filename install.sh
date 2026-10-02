#!/bin/bash
# kan installer: checks Node and Ollama, fetches the EU models, indexes the
# example notes. Re-run it any time; it skips what's already done.
#   ./install.sh          answers + note search (~2.2 GB)
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
have=$(ollama list | awk 'NR>1 {print $1}')
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# --- the two models: exact files from their makers, checked, then built ---
# Downloading the GGUF ourselves keeps out the 0.8 GB vision part that an
# Ollama pull of the 3B model brings along, which kan never uses.
while read -r name want url; do
  grep -qxF "$name:latest" <<<"$have" && { say "· $name already installed"; continue; }
  file=models/$(basename "$url")
  if [ ! -f "$file" ] || [ "$(sha "$file")" != "$want" ]; then
    say "· downloading $(basename "$url")"
    curl -fL -# --retry 3 -C - -o "$file" "$url"
  fi
  [ "$(sha "$file")" = "$want" ] || fail "$file doesn't match its sha256 in models.lock; delete it and re-run"
  ollama create "$name" -f "models/${name#kan-}.Modelfile"
  rm -f "$file"   # Ollama keeps its own copy
done < <(awk '/^kan-/ {print $1, $2, $3}' models.lock)

# --- the optional 8B, from the Ollama registry ---
if [ "${1:-}" = "--deep" ]; then
  m=ministral-3:8b
  grep -qxF "$m" <<<"$have" || { say "· pulling $m"; ollama pull "$m"; }
  want=$(awk -v m="$m" '$1==m {sub("sha256:","",$2); print $2}' models.lock)
  got=$(ollama list | awk -v m="$m" '$1==m {print $2}')
  [ "${want:0:12}" = "$got" ] || say "  note: $m is a newer build ($got) than the one kan was tested with (${want:0:12})"
fi

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
