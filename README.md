# HLSF Lite

HLSF Lite is a dual-interface experiment for working with Hierarchical Layered Semantic Framework (HLSF) prompts. It ships with:

- **Browser terminal** (`browser/index.html`): a self-contained HTML document with inline JavaScript/CSS that streams step progress, caches token adjacency matrices in IndexedDB, and surfaces collapsible sections for matrices, original outputs, and emergent thoughts.
- **Node.js CLI** (`node/cli.js`): an interactive terminal client that mirrors the pipeline with spinners, toggles for original output/emergent thoughts, and local JSON storage under `./matrices/`.
- **Shared deterministic engine** (`shared/`) implementing token transforms, adjacency analysis, and prompt scaffolding.

## Prerequisites

- OpenAI API key with access to Chat Completions.
- Node.js 18+ (for the CLI) — only built-in modules are used.

## Running the browser terminal

1. Open `browser/index.html` in a modern browser.
2. Set your API key with `key sk-...` (stored only in memory for the tab).
3. Type prompts or commands at the `>` prompt.

Features:

- Step-by-step status with rotating spinners and elapsed times.
- Streaming original and refined LLM responses.
- Collapsible token matrices; neighbor tokens fetch recursively on demand.
- IndexedDB caching with a directory viewer and JSON export button.

## Running the Node CLI

```
node node/cli.js
```

Commands mirror the browser version:

- `model <name>` – set OpenAI model (default `gpt-4o-mini`).
- `depth <n>` / `fanout <k>` – adjust BFS expansion parameters.
- `ls matrices` – list cached adjacency matrices.
- `open <TOKEN>` – pretty-print a token matrix (fetches if missing).
- `export` – write `matrices/export.json` with all cached matrices.
- `toggle original` / `toggle thoughts` – show or hide last run outputs.

If `OPENAI_API_KEY` is not set, the CLI requests it without echoing.

## Shared engine

`shared/engine.js` contains deterministic helpers:

- `tokenizeWords` for normalized token extraction.
- Centrality scoring and hierarchy formalization.
- Cross-level expansion, dynamic reorganization, attention embedding, and propagation utilities.
- Emergent thought synthesis and reflect prompt preparation.

Schemas and guards live in `shared/schema.js`, while prompts reside in `shared/prompts.js`. Relationship names are defined in `shared/relationships.js`.

## Data and caching

- Browser caches matrices in IndexedDB (`matrices` object store).
- CLI caches matrices under `./matrices/` with `index.json` and optional `export.json` bundle.
- Stored matrices include `meta.downloaded_at` timestamps for traceability.

## Security

- API keys remain in-memory only. Refreshing the browser tab or restarting the CLI session clears them.
- Do not share API keys with untrusted pages or terminals.

## Limits & heuristics

- Tokenization uses lowercase word and up-to-trigram phrases; it is heuristic, not BPE-aware.
- BFS expansion depth defaults to 2 with fanout 5 per slot to cap recursion.
- Structured outputs for adjacency matrices prefer JSON mode; falls back to JSON parsing if needed.

## License

MIT — see `LICENSE` for details.
