# Yah Forge Direct — sermon engine port

These files are ported from `yah-forge` (Poe) into the OpenRouter **yah-forge-direct** format.

## To apply on [yah-forge-direct](https://github.com/Modzter3/yah-forge-direct)

Copy into your direct repo root:

```bash
cp yah-forge-direct-port/public/index.html public/index.html
cp yah-forge-direct-port/public/ai-polyfill.js public/ai-polyfill.js
cp yah-forge-direct-port/scripts/dedupe-sermon.py scripts/dedupe-sermon.py
```

Or merge branch `cursor/sync-sermon-engine-ba72` if pushed from a machine with direct repo access.

## What was synced

- 6-part sermon split fix (boundary truncation, dedupe, auto-continue)
- Stream stall watchdog + **Stuck? Force next part** button
- **Episode Mode** toggle (TV season episode-by-episode)
- **Web Research** toggle (OpenRouter web plugin)
- Trimmed previous-part context in multi-part prompts
- TV seasons auto-recommend 6 parts
- Improved streaming completion in `ai-polyfill.js`

## OpenRouter-specific notes

- Web search uses `getSermonWebSearchParams()` → `forgeSupportsWebBrowse()` + OpenRouter `web_search` plugin (handled in `api/ai.js`)
- Model dropdowns and Destroy tab are unchanged from your direct build
