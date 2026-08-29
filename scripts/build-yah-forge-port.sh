#!/usr/bin/env bash
# Build Poe-adapted yah-forge tree from yah-forge-direct (this repo).
# Does NOT add api/ai.js, ai-polyfill.js, or openrouter-models.js — Poe billing stays on /api/poe.
# Rebuild triggers sync-to-yah-forge workflow when pushed to main.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/yah-forge-port"
YAH_FORGE_SRC="${YAH_FORGE_SRC:-}"

rm -rf "$OUT"
mkdir -p "$OUT/public" "$OUT/scripts" "$OUT/api"

cp "$ROOT/public/index.html" "$OUT/public/index.html"
python3 "$ROOT/scripts/adapt-index-for-poe.py" "$OUT/public/index.html"

# Upgraded polyfill — still routes to /api/poe (Poe billing unchanged)
cp "$ROOT/scripts/poe-polyfill-template.js" "$OUT/public/poe-polyfill.js"

cp "$ROOT/vercel.json" "$OUT/vercel.json"
cp "$ROOT/scripts/extract-forge-from-transcript.mjs" "$OUT/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/adapt-index-for-poe.py" "$OUT/scripts/"
cp "$ROOT/scripts/dedupe-sermon.py" "$OUT/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/build-yah-forge-port.sh" "$OUT/scripts/"

# Poe backend — copy from upstream yah-forge if available, else use bundled stub note
if [[ -n "$YAH_FORGE_SRC" && -f "$YAH_FORGE_SRC/api/poe.js" ]]; then
  cp "$YAH_FORGE_SRC/api/poe.js" "$OUT/api/poe.js"
  cp "$YAH_FORGE_SRC/.env.example" "$OUT/.env.example"
  cp "$YAH_FORGE_SRC/package.json" "$OUT/package.json"
  cp "$YAH_FORGE_SRC/.gitignore" "$OUT/.gitignore" 2>/dev/null || true
else
  echo "POE_API_KEY=your_poe_api_key_here" > "$OUT/.env.example"
  echo '{"name":"yah-forge","private":true}' > "$OUT/package.json"
fi

cat > "$OUT/PORT.md" <<'EOF'
# yah-forge sync package (from yah-forge-direct)

Built by `scripts/build-yah-forge-port.sh`. Poe billing preserved: `/api/poe` + `poe-polyfill.js` only.

## Deploy to Modzter3/yah-forge

```bash
git clone https://github.com/Modzter3/yah-forge.git
cd yah-forge
git checkout -b cursor/port-forge-direct-features-34e9
rsync -av --exclude PORT.md ../yah-forge-port/ ./
git add -A && git commit -m "Port yah-forge-direct features (Poe billing unchanged)"
git push -u origin cursor/port-forge-direct-features-34e9
```

Or run from yah-forge-direct: `YAH_FORGE_SYNC_TOKEN=ghp_... ./scripts/push-yah-forge-port.sh`
EOF

echo "Built $OUT ($(wc -l < "$OUT/public/index.html") lines index.html)"
