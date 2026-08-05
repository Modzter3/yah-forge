#!/usr/bin/env python3
"""Remove duplicate Part N blocks from multi-part sermon text."""
import re
import sys


def normalize_glued_headers(text: str) -> str:
    return re.sub(
        r"(?<=\S)(#\s*Part\s*\d+\s*:)",
        r"\n\n\1",
        text,
        flags=re.IGNORECASE,
    )


def dedupe_multipart_sermon(text: str) -> str:
    if not text:
        return text
    text = normalize_glued_headers(text.strip())

    for n in range(6, 0, -1):
        hash_pat = re.compile(rf"#\s*Part\s*{n}\s*:", re.IGNORECASE)
        plain_pat = re.compile(rf"(?:^|\n)Part\s*{n}\s*:", re.IGNORECASE)

        hash_matches = list(hash_pat.finditer(text))
        if not hash_matches:
            continue

        plain_before = plain_pat.search(text[: hash_matches[0].start()])
        if plain_before:
            dup_start = hash_matches[0].start()
        elif len(hash_matches) >= 2:
            dup_start = hash_matches[1].start()
        else:
            continue

        dup_end = len(text)
        if n < 6:
            next_pat = re.compile(
                rf"(?:^|\n)(?:---\s*\n+)?(?:#\s*)?Part\s*{n + 1}\s*:",
                re.MULTILINE | re.IGNORECASE,
            )
            nm = next_pat.search(text, dup_start + 5)
            if nm:
                dup_end = nm.start()

        text = text[:dup_start].rstrip() + "\n\n" + text[dup_end:].lstrip()

    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_markdown_for_tts(text: str) -> str:
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s in ("---", "***", "___"):
            continue
        if s.startswith("#"):
            s = re.sub(r"^#+\s*", "", s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
        s = re.sub(r"\*([^*]+)\*", r"\1", s)
        s = re.sub(r"`([^`]+)`", r"\1", s)
        if s:
            lines.append(s)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(lines)).strip()


def split_into_parts(text: str) -> list[tuple[int, str]]:
    pat = re.compile(r"^#\s*Part\s*(\d+)\s*:", re.MULTILINE | re.IGNORECASE)
    matches = list(pat.finditer(text))
    if not matches:
        return [(1, text)]
    parts = []
    for i, m in enumerate(matches):
        num = int(m.group(1))
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        parts.append((num, text[start:end].strip()))
    return parts


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "/workspace/empire-s2-raw.txt"
    md_out = sys.argv[2] if len(sys.argv) > 2 else "/workspace/Empire-Season-2-CLEAN.md"
    txt_out = sys.argv[3] if len(sys.argv) > 3 else "/workspace/Empire-Season-2-CLEAN.txt"
    parts_dir = sys.argv[4] if len(sys.argv) > 4 else "/workspace/docs/empire-s2"

    with open(src, encoding="utf-8") as f:
        raw = f.read()

    cleaned = dedupe_multipart_sermon(raw)
    plain = strip_markdown_for_tts(cleaned)

    with open(md_out, "w", encoding="utf-8") as f:
        f.write(cleaned)
    with open(txt_out, "w", encoding="utf-8") as f:
        f.write(plain)

    import os

    os.makedirs(parts_dir, exist_ok=True)
    for num, part_text in split_into_parts(cleaned):
        part_plain = strip_markdown_for_tts(part_text)
        with open(os.path.join(parts_dir, f"Part-{num}.txt"), "w", encoding="utf-8") as f:
            f.write(part_plain)

    print(f"Raw: {len(raw):,} chars")
    print(f"Cleaned MD: {len(cleaned):,} chars -> {md_out}")
    print(f"Plain TTS: {len(plain):,} chars -> {txt_out}")
    print(f"Parts written to {parts_dir}")


if __name__ == "__main__":
    main()
