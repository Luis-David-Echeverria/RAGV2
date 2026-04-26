"""MCP server exposing save_memory and search_memory to Claude."""
import json
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

from .config import load_config
from .memory import save_memory, search_memory

server = Server("stellium-memory")
_cfg = None


def _get_cfg():
    global _cfg
    if _cfg is None:
        _cfg = load_config()
    return _cfg


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="save_memory",
            description=(
                "Save important information from the current conversation to the personal "
                "knowledge graph. Use this to persist key decisions, context, and entities."
            ),
            inputSchema={
                "type": "object",
                "required": ["topic", "summary"],
                "properties": {
                    "topic": {"type": "string", "description": "Short topic title for this session"},
                    "summary": {"type": "string", "description": "Main content to remember"},
                    "key_decisions": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Important decisions made",
                    },
                    "entities_mentioned": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Named entities discussed (people, tools, concepts)",
                    },
                    "open_items": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Follow-up tasks or unresolved questions",
                    },
                    "context": {"type": "string", "description": "Additional background context"},
                    "previous_session_id": {
                        "type": "string",
                        "description": "session_id of the preceding conversation, if any",
                    },
                },
            },
        ),
        types.Tool(
            name="search_memory",
            description=(
                "Search the personal knowledge graph for relevant information. "
                "Returns a concise summary and a graph visualization payload (stellium_data)."
            ),
            inputSchema={
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {"type": "string", "description": "What to search for"},
                    "mode": {
                        "type": "string",
                        "enum": ["auto", "local", "global", "hybrid"],
                        "description": "Retrieval mode. 'auto' lets the agent decide.",
                        "default": "auto",
                    },
                },
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    cfg = _get_cfg()

    if name == "save_memory":
        path = save_memory(cfg=cfg, **arguments)
        return [types.TextContent(type="text", text=f"Memory saved to: {path}")]

    if name == "search_memory":
        result = search_memory(
            query=arguments["query"],
            mode=arguments.get("mode", "auto"),
            cfg=cfg,
        )
        return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]

    return [types.TextContent(type="text", text=f"Unknown tool: {name}")]


def main():
    import asyncio
    asyncio.run(stdio_server(server))


if __name__ == "__main__":
    main()
