#!/usr/bin/env python3
"""Adapt yah-forge-direct index.html for Poe-hosted yah-forge (Poe billing unchanged)."""
import re
import sys
from pathlib import Path

p = Path(sys.argv[1] if len(sys.argv) > 1 else "public/index.html")
s = p.read_text(encoding="utf-8")

s = s.replace("/ai-polyfill.js", "/poe-polyfill.js")
s = re.sub(r'\s*<script src="/openrouter-models\.js"></script>\s*\n', "\n", s)

s = s.replace("google/gemini-2.5-flash", "Gemini-3.6-Flash")
s = s.replace("google/gemini-3.6-flash", "Gemini-3.6-Flash")

s = s.replace(
    "Type any OpenRouter model id (e.g. google/gemini-2.5-pro) to override the dropdown",
    "Type any Poe bot name (e.g. Gemini-3.6-Flash) to override the dropdown",
)
s = s.replace(
    "Type any OpenRouter model id (e.g. anthropic/claude-sonnet-4) to override the dropdown",
    "Type any Poe bot name (e.g. Claude-Sonnet-5) to override the dropdown",
)
s = s.replace(
    "Custom model id -- browsing/plugins depend on OpenRouter + provider; check the model card.",
    "Custom Poe bot -- web search depends on bot + Poe; check Poe bot page for browse support.",
)
s = s.replace(
    "Try again or switch to a faster model (e.g. <strong>Google Gemini Flash</strong> on OpenRouter).",
    "Try again or switch to a faster Poe bot (e.g. <strong>Gemini-3.6-Flash</strong>).",
)
s = s.replace(
    "Try another frontier model (Gemini / GPT / Claude on OpenRouter), or scan again.",
    "Try another Poe bot (Gemini / GPT / Claude), or scan again.",
)

if 'rel="icon"' not in s and "marked.min.js" in s:
    s = s.replace(
        '<script src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js" crossorigin="anonymous"></script>\n',
        '<script src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js" crossorigin="anonymous"></script>\n'
        '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>🔥</text></svg>">\n',
    )

p.write_text(s, encoding="utf-8")
print("Adapted", p)
