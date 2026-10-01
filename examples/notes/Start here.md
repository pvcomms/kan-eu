# Start here

These are example notes so you can try kan straight after installing it. Replace them with your own: point `memory.sources` in `config/kan.json` at any folder of Markdown or text files, then run `kan index`.

## What kan does with notes

kan never edits your notes. It reads them, splits them into passages, and stores a vector for each passage in `data/memory.db`. When you ask something, it finds the closest passages. Then a quick yes/no decision from the small model settles whether they're relevant before they're handed to the model that writes the answer.

## Where things live

Everything stays on this computer: the notes, the index, the models. There is no account and nothing to sync.
