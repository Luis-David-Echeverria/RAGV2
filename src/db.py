import sqlite3
from contextlib import contextmanager
from pathlib import Path


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ingested_files (
                file_name        TEXT PRIMARY KEY,
                original_path    TEXT NOT NULL,
                origin           TEXT NOT NULL,
                file_type        TEXT NOT NULL,
                content_hash     TEXT NOT NULL,
                chunk_count      INTEGER,
                token_count      INTEGER,
                lightrag_doc_id  TEXT,
                ingested_at      TEXT NOT NULL,
                chunking_strategy TEXT
            );

            CREATE TABLE IF NOT EXISTS entity_file_map (
                entity_name      TEXT PRIMARY KEY,
                file_name        TEXT NOT NULL,
                kg_id            TEXT,
                last_synced      TEXT NOT NULL,
                description_hash TEXT
            );

            CREATE TABLE IF NOT EXISTS source_file_map (
                lightrag_doc_id  TEXT PRIMARY KEY,
                file_name        TEXT NOT NULL,
                original_file    TEXT,
                last_synced      TEXT NOT NULL
            );
        """)


@contextmanager
def connect(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def is_ingested(db_path: Path, file_name: str, content_hash: str) -> bool:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT content_hash FROM ingested_files WHERE file_name = ?",
            (file_name,),
        ).fetchone()
    return row is not None and row["content_hash"] == content_hash


def record_ingested(db_path: Path, *, file_name: str, original_path: str, origin: str,
                    file_type: str, content_hash: str, chunk_count: int,
                    token_count: int, lightrag_doc_id: str, ingested_at: str,
                    chunking_strategy: str) -> None:
    with connect(db_path) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO ingested_files
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (file_name, original_path, origin, file_type, content_hash,
              chunk_count, token_count, lightrag_doc_id, ingested_at, chunking_strategy))


def upsert_entity(db_path: Path, *, entity_name: str, file_name: str,
                  kg_id: str, last_synced: str, description_hash: str) -> None:
    with connect(db_path) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO entity_file_map
            VALUES (?,?,?,?,?)
        """, (entity_name, file_name, kg_id, last_synced, description_hash))


def upsert_source(db_path: Path, *, lightrag_doc_id: str, file_name: str,
                  original_file: str, last_synced: str) -> None:
    with connect(db_path) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO source_file_map
            VALUES (?,?,?,?)
        """, (lightrag_doc_id, file_name, original_file, last_synced))


def get_all_entity_names(db_path: Path) -> set[str]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT entity_name FROM entity_file_map").fetchall()
    return {r["entity_name"] for r in rows}


def get_all_source_ids(db_path: Path) -> set[str]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT lightrag_doc_id FROM source_file_map").fetchall()
    return {r["lightrag_doc_id"] for r in rows}
