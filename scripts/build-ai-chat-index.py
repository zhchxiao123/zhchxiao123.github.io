#!/usr/bin/env python3
"""
Build a static RAG index for the AI chat widget.

Reads Jekyll posts from _posts/*.md, splits each post by headings into chunks,
and writes assets/js/data/ai-chat-index.json.

Run after `bundle exec jekyll b` so that _site/posts/ HTML is also available.
"""

import json
import re
import sys
from pathlib import Path
from datetime import datetime, timezone


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~1.5 tokens per CJK char, ~1.3 per word for Latin."""
    cjk = len(re.findall(r"[一-鿿]", text))
    others = len(re.findall(r"[a-zA-Z0-9]+", text))
    return int(cjk * 1.5 + others * 1.3)


def strip_front_matter(content: str) -> str:
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            return parts[2].strip()
    return content


def split_by_headings(markdown: str):
    """Split markdown into chunks, each anchored at its nearest heading."""
    lines = markdown.splitlines()
    chunks = []
    current_heading = ""
    current_heading_level = 0
    current_body_lines = []

    def flush():
        if not current_body_lines:
            return
        body = "\n".join(current_body_lines).strip()
        if not body:
            return
        chunks.append({
            "heading": current_heading,
            "heading_level": current_heading_level,
            "text": body,
        })
        current_body_lines.clear()

    heading_re = re.compile(r"^(#{2,4})\s+(.+)$")

    for line in lines:
        m = heading_re.match(line)
        if m:
            flush()
            current_heading_level = len(m.group(1))
            current_heading = m.group(2).strip()
            continue
        current_body_lines.append(line)

    flush()
    return chunks


def chunk_text(text: str, max_tokens: int = 500, overlap_tokens: int = 80) -> list[str]:
    """Split long text into overlapping chunks by approximate token count."""
    tokens = estimate_tokens(text)
    if tokens <= max_tokens:
        return [text]

    words = text.split()
    chunks = []
    start = 0
    while start < len(words):
        end = start
        current_tokens = 0
        while end < len(words) and current_tokens < max_tokens:
            word = words[end]
            current_tokens += estimate_tokens(word)
            end += 1

        chunks.append(" ".join(words[start:end]).strip())

        # Overlap step
        overlap_start = max(0, end - 1)
        overlap_tokens_count = 0
        while overlap_start > start and overlap_tokens_count < overlap_tokens:
            overlap_start -= 1
            overlap_tokens_count += estimate_tokens(words[overlap_start])

        start = overlap_start if overlap_start > start else end
        if end == start:
            break

    return [c for c in chunks if c]


def parse_post(path: Path, site_url: str = "") -> dict | None:
    content = path.read_text(encoding="utf-8")
    body = strip_front_matter(content)

    # Extract title from front matter
    title_match = re.search(r'^title:\s*"([^"]+)"', content, re.MULTILINE)
    if not title_match:
        title_match = re.search(r"^title:\s*'([^']+)'", content, re.MULTILINE)
    if not title_match:
        title_match = re.search(r"^title:\s*(.+)$", content, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else path.stem

    # Extract date from filename or front matter
    date_match = re.search(r"^(\d{4}-\d{2}-\d{2})-", path.name)
    date_str = date_match.group(1) if date_match else ""

    # Permalink-style URL from filename
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", path.stem)
    url = f"/posts/{slug}/"

    # Split by headings, then further chunk if too large
    heading_chunks = split_by_headings(body)

    chunks = []
    for i, hc in enumerate(heading_chunks):
        sub_texts = chunk_text(hc["text"], max_tokens=500, overlap_tokens=80)
        for j, sub in enumerate(sub_texts):
            chunks.append({
                "id": f"{slug}-h{i}-c{j}",
                "url": url,
                "title": title,
                "date": date_str,
                "heading": hc["heading"],
                "heading_level": hc["heading_level"],
                "text": sub,
                "word_count": len(sub),
                "token_estimate": estimate_tokens(sub),
            })

    return {
        "title": title,
        "url": url,
        "slug": slug,
        "date": date_str,
        "chunks": chunks,
    }


def main():
    repo_root = Path(__file__).resolve().parent.parent
    posts_dir = repo_root / "_posts"
    output_dir = repo_root / "assets" / "js" / "data"
    output_file = output_dir / "ai-chat-index.json"

    if not posts_dir.exists():
        print(f"Error: posts directory not found: {posts_dir}", file=sys.stderr)
        sys.exit(1)

    all_chunks = []
    posts_meta = []

    for post_path in sorted(posts_dir.glob("*.md")):
        try:
            result = parse_post(post_path)
            if result and result["chunks"]:
                all_chunks.extend(result["chunks"])
                posts_meta.append({
                    "title": result["title"],
                    "url": result["url"],
                    "slug": result["slug"],
                    "date": result["date"],
                    "chunk_count": len(result["chunks"]),
                })
        except Exception as e:
            print(f"Warning: failed to parse {post_path}: {e}", file=sys.stderr)

    index = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
        "post_count": len(posts_meta),
        "chunk_count": len(all_chunks),
        "posts": posts_meta,
        "chunks": all_chunks,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {len(all_chunks)} chunks from {len(posts_meta)} posts to {output_file}")


if __name__ == "__main__":
    main()
