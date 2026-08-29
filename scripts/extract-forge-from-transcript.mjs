import fs from 'fs';
import path from 'path';

const transcript = path.join(
  process.env.USERPROFILE,
  '.cursor/projects/c-Users-nealy-yah-forge-direct/agent-transcripts/682f8d23-ac5a-40a6-b6fb-3a59c30af665/682f8d23-ac5a-40a6-b6fb-3a59c30af665.jsonl'
);

const raw = fs.readFileSync(transcript, 'utf8');
const lines = raw.split('\n');
let html = '';

for (const line of lines) {
  if (!line.trim()) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const t = o?.message?.content?.[0]?.text;
  if (t && t.includes('heres the original:') && t.includes('<!DOCTYPE html>')) {
    const i = t.indexOf('<!DOCTYPE html>');
    html = t.slice(i);
    break  }
}

if (!html) {
  console.error('Could not find embedded HTML in transcript');
  process.exit(1);
}

const out = path.join(process.cwd(), 'public', '_extracted-forge.html');
fs.writeFileSync(out, html, 'utf8');
console.log('Wrote', out, 'bytes', html.length);
