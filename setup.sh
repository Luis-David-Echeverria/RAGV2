#!/usr/bin/env bash
# Phase 1: LightRAG server setup
# Run once, then keep the server running with: lightrag-server

set -e

echo "=== Stellium Setup ==="

# 1. Install dependencies
pip install uv 2>/dev/null || true
uv pip install -e ".[dev]" 2>/dev/null || pip install -e .
uv tool install "lightrag-hku[api]" 2>/dev/null || pip install "lightrag-hku[api]"

# 2. Copy .env if not exists
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env — edit it with your GOOGLE_API_KEY and VAULT_PATH before continuing."
    exit 0
fi

# 3. Create LightRAG storage dir
source .env
mkdir -p "${LIGHTRAG_STORAGE_DIR:-./lightrag_storage}"

# 4. Create vault structure
if [ -n "$VAULT_PATH" ]; then
    mkdir -p "$VAULT_PATH/entities"
    mkdir -p "$VAULT_PATH/sources"
    mkdir -p "$VAULT_PATH/inbox/claude"
    mkdir -p "$VAULT_PATH/inbox/user"
    mkdir -p "$VAULT_PATH/processed/claude"
    mkdir -p "$VAULT_PATH/processed/user"
    mkdir -p "$VAULT_PATH/_meta/orphaned"
    echo "Vault structure created at: $VAULT_PATH"
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit .env with your GOOGLE_API_KEY and VAULT_PATH (if not done)"
echo "  2. Configure LightRAG server .env for Gemini (see LightRAG docs)"
echo "  3. Start LightRAG: lightrag-server"
echo "  4. Verify: rag status"
echo "  5. Drop files in \$VAULT_PATH/inbox/user/ and run: rag ingest"
echo "  6. Sync to Obsidian: rag sync"
echo ""
echo "MCP server: python -m src.mcp_server"
