from dataclasses import dataclass
from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"Define it in your .env (see .env.example or README)."
        )
    return value


@dataclass
class Config:
    google_api_key: str
    gemini_llm_cheap: str
    gemini_llm_smart: str
    gemini_embedding_model: str
    lightrag_host: str
    lightrag_storage_dir: Path
    vault_path: Path
    aliases_path: Path
    chunk_max_tokens: int
    retrieval_top_k: int
    db_path: Path


def load_config() -> Config:
    vault_path = Path(_require_env("VAULT_PATH"))
    storage_dir = Path(os.environ.get("LIGHTRAG_STORAGE_DIR", "./lightrag_storage"))
    return Config(
        google_api_key=_require_env("GOOGLE_API_KEY"),
        gemini_llm_cheap=os.environ.get("GEMINI_LLM_CHEAP", "gemini-2.5-flash-lite"),
        gemini_llm_smart=os.environ.get("GEMINI_LLM_SMART", "gemini-2.5-flash"),
        gemini_embedding_model=os.environ.get("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001"),
        lightrag_host=os.environ.get("LIGHTRAG_HOST", "http://localhost:9621"),
        lightrag_storage_dir=storage_dir,
        vault_path=vault_path,
        aliases_path=Path(__file__).parent.parent / "config" / "aliases.yaml",
        chunk_max_tokens=int(os.environ.get("CHUNK_MAX_TOKENS", "4000")),
        retrieval_top_k=int(os.environ.get("RETRIEVAL_TOP_K", "60")),
        db_path=vault_path / "_meta" / "sync_state.db",
    )
