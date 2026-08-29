#!/usr/bin/env python3
"""
Clean combined sermon markdown: dedupe Part headers, fix glued headings, optional plain text.

Mirrors finalizeSermonPartText() / stripLeadingPartHeading() in public/index.html.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PART_HEADING_LINE = re.compile(
    r"^#+\s*(?:PART|Part|EPISODE|Episode)\s*(\d+)\s*[:\-–—]",
    re.MULTILINE | re.IGNORECASE,
)
PART_HEADING_FULL = re.compile(
    r"^#+\s*(?:PART|Part|EPISODE|Episode)\s*\d+\s*[:\-–—]+\s*.+\n+",
    re.MULTILINE | re.IGNORECASE,
)
GLUED_HEADER = re.compile(
    r"([^\n\s])(\s*)(#+\s*(?:Part|PART|Episode|EPISODE)\s*\d+\s*[:\-–—])",
    re.IGNORECASE,
)
DOT_GLUED = re.compile(
    r"\.(#+\s*(?:Part|PART|Episode|EPISODE)\s*\d+)",
    re.IGNORECASE,
)
STANDALONE_H1 = re.compile(r"^#\s+(?!#).+\n+", re.MULTILINE)
ASSEMBLY_PART = re.compile(
    r"^#\s*PART\s+(\d+)\s*--\s*(.+?)\s*\n\n",
    re.MULTILINE | re.IGNORECASE,
)
URL_PATTERNS = [
    re.compile(r"\[([^\]]*)\]\((?:https?://|www\.)[^)\s]+[^)]*?\)", re.IGNORECASE),
    re.compile(r"\bhttps?://[^\s\])>'\"<]+", re.IGNORECASE),
    re.compile(r"\bwww\.[^\s\])>'\"<]+", re.IGNORECASE),
]


def strip_media_sources(text: str) -> str:
    for pat in URL_PATTERNS:
        text = pat.sub(lambda m: m.group(1) if m.lastindex else "", text)
    text = re.sub(
        r"^\s*#{1,6}\s*(?:sources?|references?|bibliography)\s*:?\s*$",
        "",
        text,
        flags=re.MULTILINE | re.IGNORECASE,
    )
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def truncate_at_next_part_boundary(text: str, current_part: int) -> str:
    lines = text.split("\n")
    cut = -1
    for i, line in enumerate(lines):
        m = PART_HEADING_LINE.match(line.strip())
        if m and int(m.group(1)) > current_part:
            cut = i
            break
    if cut >= 0:
        return "\n".join(lines[:cut]).rstrip()
    return text


def dedupe_part_headers(text: str) -> str:
    text = GLUED_HEADER.sub(r"\1\n\n\3", text)
    text = DOT_GLUED.sub(r".\n\n\1", text)
    lines = text.split("\n")
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = PART_HEADING_LINE.match(line.strip())
        if m:
            pn = m.group(1)
            if pn in seen:
                continue
            seen.add(pn)
        out.append(line)
    return "\n".join(out)


def strip_leading_part_heading(text: str) -> str:
    if not text:
        return text
    out = text.lstrip("\ufeff").lstrip()
    while True:
        m = PART_HEADING_FULL.match(out)
        if not m:
            break
        out = out[m.end() :]
    m = STANDALONE_H1.match(out)
    if m:
        out = out[m.end() :]
    return out.lstrip("\n")


def finalize_part_text(text: str, part_num: int, strip_urls: bool = True) -> str:
    out = truncate_at_next_part_boundary(text, part_num)
    out = dedupe_part_headers(out)
    if strip_urls:
        out = strip_media_sources(out)
    return out


def md_to_plain(text: str) -> str:
    text = re.sub(r"^#+\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[-*]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def dedupe_combined_markdown(text: str, strip_urls: bool = True) -> str:
    chunks = re.split(r"\n---\n", text)
    if len(chunks) <= 1:
        return finalize_part_text(strip_leading_part_heading(text), 1, strip_urls)

    out_chunks: list[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        piece = chunk.strip("\n")
        if not piece:
            continue
        m = ASSEMBLY_PART.match(piece)
        if m:
            part_num, title = m.group(1), m.group(2).strip()
            body = finalize_part_text(
                strip_leading_part_heading(piece[m.end() :]), int(part_num), strip_urls
            )
            out_chunks.append(f"# PART {part_num} -- {title}\n\n{body}".rstrip())
        else:
            out_chunks.append(
                finalize_part_text(strip_leading_part_heading(piece), idx, strip_urls).rstrip()
            )

    return "\n\n---\n\n".join(out_chunks) + ("\n" if text.endswith("\n") else "")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Dedupe sermon Part headers and optionally strip to plain text."
    )
    parser.add_argument("paths", nargs="*", help="Markdown files (default: stdin)")
    parser.add_argument("-o", "--output", help="Write result to this file")
    parser.add_argument("-i", "--in-place", action="store_true", help="Rewrite inputs")
    parser.add_argument(
        "--plain",
        action="store_true",
        help="Output plain text (no markdown) after dedupe",
    )
    parser.add_argument(
        "--keep-urls",
        action="store_true",
        help="Do not strip URLs / source blocks",
    )
    args = parser.parse_args()

    if args.in_place and args.output:
        parser.error("Use either --in-place or --output, not both")

    def finish(raw: str) -> str:
        result = dedupe_combined_markdown(raw, strip_urls=not args.keep_urls)
        return md_to_plain(result) if args.plain else result

    if not args.paths:
        raw = sys.stdin.read()
        result = finish(raw)
        if args.in_place:
            parser.error("--in-place requires at least one input path")
        if args.output:
            Path(args.output).write_text(result, encoding="utf-8")
        else:
            sys.stdout.write(result)
        return 0

    for path_str in args.paths:
        path = Path(path_str)
        raw = path.read_text(encoding="utf-8")
        result = finish(raw)
        if args.in_place:
            path.write_text(result, encoding="utf-8")
        elif args.output and len(args.paths) == 1:
            Path(args.output).write_text(result, encoding="utf-8")
        else:
            if len(args.paths) > 1:
                sys.stdout.write(f"## {path}\n\n")
            sys.stdout.write(result)
            if len(args.paths) > 1:
                sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
