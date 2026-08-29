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
