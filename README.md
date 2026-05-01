# Stellium

A personal knowledge system that turns your notes into a navigable star-field.
Stellium ingests files from an Obsidian vault into a LightRAG-backed knowledge
graph, lets you query it through Gemini, and surfaces the result as an animated
3D constellation inside Obsidian itself — plus a Windows tray app so you don't
have to live in the terminal.

## What's in here

| Piece | Path | What it is |
| --- | --- | --- |
| Python backend | [src/](src/) | Click CLI (`rag …`), ingest pipeline, query agent, MCP server. |
| Tray app | [src/desktop/](src/desktop/) | PySide6 `QSystemTrayIcon` with cost preview, settings, LightRAG start/stop. |
| Obsidian plugin | [obsidian-3d-graph-master/](obsidian-3d-graph-master/) | Stellium 3D graph view (hard fork of vasturiano's 3d-graph + custom aurora / spark / threads renderer). |
| Aliases / config | [config/aliases.yaml](config/aliases.yaml) | Entity-name aliases for the dedup pass. |
| Eval set | [eval_set.yaml](eval_set.yaml) | YAML retrieval-quality test cases. |

## Setup on a new machine

Tested on Windows 11 + Python 3.12 + Bun 1.x + Obsidian latest.

### 1. Clone

```bash
git clone https://github.com/<you>/Stellium.git
cd Stellium
```

### 2. Python deps

```bash
python -m pip install -e .
# Or, if you use uv:
#   uv pip install -e .
```

### 3. Environment

```bash
cp .env.example .env
# Then edit .env and fill in:
#   - GOOGLE_API_KEY (https://aistudio.google.com/app/apikey)
#   - JINA_API_KEY   (https://jina.ai/api-dashboard) — optional, only if RERANK_BINDING=jina
#   - VAULT_PATH     (absolute path to your Obsidian vault)
```

### 4. Vault structure

The first run of `rag ingest` (or the tray's "Ingest now") creates the layout
under `$VAULT_PATH`:

```
inbox/{claude,user}/    notes waiting to be ingested
processed/{...}/        notes already in the graph
entities/               .md page per entity LightRAG extracted
sources/                .md page per source document
_meta/                  sync_state.db, stellium_highlight.json, token_usage.jsonl
```

### 5. Build the Obsidian plugin

```bash
cd obsidian-3d-graph-master
bun install
bun run build
```

Copy the build artifacts to the vault's plugin folder:

```
$VAULT_PATH/.obsidian/plugins/stellium-graph/
    main.js
    manifest.json
    styles.css
```

Reload Obsidian (`Ctrl+P → Reload app`) and enable **Stellium Graph** in
*Settings → Community plugins*.

## Running it

There are two long-running processes — start them in this order:

```bash
# Terminal 1 — LightRAG REST server (or use the tray's "Start LightRAG")
lightrag-server

# Terminal 2 — Stellium tray app
python -m src.desktop.tray
```

The tray icon appears in the Windows system tray. Right-click it for:

- **Run query…** — pre-flight cost estimate → dialog → result toast
- **Ingest now / Claude only / User only** — same flow for the inbox
- **Sync vault** — write entity/source `.md` pages to the vault
- **Dedup entities** — fuzzy merge pass
- **Open Stellium vault / Open log file**
- **Open balance dashboard** → Jina, Gemini AI Studio, Google Cloud Billing
- **Start / Stop LightRAG** — manages the server subprocess for you
- **Settings…** — vault path, models, top K, reranker on/off

The status header shows live: `LightRAG: ✔ · inbox: 3 · today: $0.0054`. Today's
spend is tracked in `_meta/token_usage.jsonl` per call (actual usage from the
Gemini token tracker; ingest cost is the central estimate since LightRAG-internal
calls aren't observable from the REST API).

## CLI alternative

If you prefer the terminal, every tray action has a Click subcommand:

```bash
python -m src.cli ingest [--source claude|user] [--dry-run]
python -m src.cli sync   [--entities-only|--sources-only] [--clean]
python -m src.cli query  "your question here"
python -m src.cli dedup  [--dry-run]
python -m src.cli stats
python -m src.cli status
python -m src.cli reset  [--hard]
python -m src.cli tray
```

## Cost expectations

Rough order of magnitude with `RETRIEVAL_TOP_K=15` and `RERANK_BINDING=jina`:

| Op | Typical cost |
| --- | --- |
| `query` (data path) | ≈ $0.002 |
| `query` (synth path) | ≈ $0.005 – $0.008 |
| `ingest` per ~50 chunks | ≈ $0.05 – $0.10 |

Edit [src/desktop/pricing.py](src/desktop/pricing.py) if Google or Jina change
their published rates.

## Architecture in one diagram

```
       Obsidian (plugin)              Tray (PySide6)
             │                              │
             │ reads/writes                 │ Click ops
             ▼                              ▼
  $VAULT_PATH/_meta/stellium_highlight.json    src/cli.py
             ▲                              │
             │ writes                       │ imports
             │                              ▼
        src/agent.py  ──────────►  src/lightrag_client.py
        (Gemini)                       │
                                       ▼
                          lightrag-server (REST :9621)
                                       │
                                       ▼
                              ./lightrag_storage/
```

## License

[MIT](LICENSE). The Obsidian plugin is a fork — its original LICENSE lives at
[obsidian-3d-graph-master/LICENSE](obsidian-3d-graph-master/LICENSE) and the
upstream project is credited there.
