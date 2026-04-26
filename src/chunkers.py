"""Smart chunking by file type. Returns list[str] — never splits mid-function."""
import ast
import csv
import io
import json
import re
from pathlib import Path


def chunk_file(path: Path) -> tuple[list[str], str]:
    """Return (chunks, strategy_name)."""
    suffix = path.suffix.lower()
    text = path.read_text(encoding="utf-8", errors="replace")

    if suffix == ".py":
        return _chunk_python(text, path), "ast_python"
    if suffix in (".js", ".ts", ".jsx", ".tsx"):
        return _chunk_js(text, path), "regex_js"
    if suffix == ".json":
        return _chunk_json(text), "json_keys"
    if suffix in (".yaml", ".yml"):
        return _chunk_yaml(text), "yaml_keys"
    if suffix in (".csv", ".tsv"):
        return _chunk_csv(text, suffix), "csv_rows"
    if suffix == ".pdf":
        return _chunk_pdf(path), "pdf_extract"
    if suffix == ".docx":
        return _chunk_docx(path), "docx_extract"
    # .md, .txt, and unknown: return whole text (LightRAG default chunker handles it)
    return [text], "default"


# ── Python ───────────────────────────────────────────────────────────────────

def _chunk_python(text: str, path: Path) -> list[str]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return [text]

    lines = text.splitlines(keepends=True)
    header = _py_imports_header(tree, lines, path)
    chunks = []

    top_level = [n for n in ast.walk(tree)
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                 and n.col_offset == 0]

    if not top_level:
        return [text]

    top_level.sort(key=lambda n: n.lineno)
    used_lines: set[int] = set()

    for node in top_level:
        start = node.lineno - 1
        end = node.end_lineno
        chunk_lines = lines[start:end]
        used_lines.update(range(start, end))
        chunk = header + "".join(chunk_lines)
        chunks.append(chunk)

    # Remaining top-level code (module-level statements not in functions/classes)
    remainder = "".join(l for i, l in enumerate(lines) if i not in used_lines).strip()
    if remainder:
        chunks.append(header + remainder)

    return chunks or [text]


def _py_imports_header(tree, lines, path: Path) -> str:
    import_lines = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            import_lines.append(lines[node.lineno - 1].rstrip())
    prefix = f"# File: {path.name}\n"
    if import_lines:
        prefix += "\n".join(import_lines) + "\n\n"
    return prefix


# ── JavaScript / TypeScript ───────────────────────────────────────────────────

_JS_FUNC_RE = re.compile(
    r"(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|class\s+\w+)",
    re.MULTILINE,
)


def _chunk_js(text: str, path: Path) -> list[str]:
    header = f"// File: {path.name}\n"
    matches = list(_JS_FUNC_RE.finditer(text))
    if not matches:
        return [header + text]

    chunks = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(header + chunk)
    return chunks or [header + text]


# ── JSON ──────────────────────────────────────────────────────────────────────

def _chunk_json(text: str) -> list[str]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return [text]
    if not isinstance(data, dict):
        return [text]
    return [json.dumps({k: v}, ensure_ascii=False, indent=2) for k, v in data.items()]


# ── YAML ──────────────────────────────────────────────────────────────────────

def _chunk_yaml(text: str) -> list[str]:
    try:
        import yaml
        data = yaml.safe_load(text)
    except Exception:
        return [text]
    if not isinstance(data, dict):
        return [text]
    chunks = []
    for k, v in data.items():
        try:
            import yaml
            chunks.append(yaml.dump({k: v}, allow_unicode=True))
        except Exception:
            chunks.append(f"{k}: {v}")
    return chunks or [text]


# ── CSV / TSV ─────────────────────────────────────────────────────────────────

_CSV_BATCH = 50


def _chunk_csv(text: str, suffix: str) -> list[str]:
    delimiter = "\t" if suffix == ".tsv" else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)
    if not rows:
        return [text]
    headers = rows[0]
    header_line = delimiter.join(headers)
    chunks = []
    for i in range(1, len(rows), _CSV_BATCH):
        batch = rows[i: i + _CSV_BATCH]
        body = "\n".join(delimiter.join(r) for r in batch)
        chunks.append(header_line + "\n" + body)
    return chunks or [text]


# ── PDF ───────────────────────────────────────────────────────────────────────

def _chunk_pdf(path: Path) -> list[str]:
    try:
        import pymupdf  # fitz
        doc = pymupdf.open(str(path))
        text = "\n\n".join(page.get_text() for page in doc)
        doc.close()
    except Exception:
        return [path.read_bytes().decode("utf-8", errors="replace")]
    return [text] if text.strip() else [f"[PDF: {path.name} — no extractable text]"]


# ── DOCX ──────────────────────────────────────────────────────────────────────

def _chunk_docx(path: Path) -> list[str]:
    try:
        from docx import Document
        doc = Document(str(path))
        text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    except Exception:
        return [f"[DOCX: {path.name} — extraction failed]"]
    return [text] if text.strip() else [f"[DOCX: {path.name} — empty]"]
