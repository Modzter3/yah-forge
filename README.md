# YAH's Word Forge — Vercel Deployment

Sermon generator originally built for the Poe app, now deployable as a standalone web app on Vercel while still calling Poe bots via their external API.

---

## How it works

| Layer | File | Role |
|---|---|---|
| Frontend | `index.html` | Original app UI, unchanged |
| Polyfill | `public/poe-polyfill.js` | Replaces `window.Poe` SDK with fetch calls |
| API Proxy | `api/poe.js` | Vercel Edge Function — proxies requests to Poe API |

When the app runs outside of Poe, `window.Poe` is injected by the polyfill. Every `window.Poe.sendUserMessage(...)` call is forwarded to `/api/poe`, which securely adds the Poe API key and streams the response back via Server-Sent Events.

---

## Setup

### 1. Get a Poe API Key

1. Go to [poe.com/api_key](https://poe.com/api_key) (must have a Poe subscription that includes API access).
2. Create an API key.

### 2. Deploy to Vercel

#### Option A — Vercel CLI

```bash
npm i -g vercel
vercel
```

When prompted, set the environment variable `POE_API_KEY` to your key.

#### Option B — Vercel Dashboard

1. Push this repo to GitHub.
2. Import the repo on [vercel.com/new](https://vercel.com/new).
3. In **Settings → Environment Variables**, add:
   - **Name:** `POE_API_KEY`
   - **Value:** your Poe API key

### 3. Local development

```bash
npm i -g vercel
cp .env.example .env.local
# Edit .env.local and set POE_API_KEY=...
vercel dev
```

`vercel dev` runs the Edge Function locally and serves `index.html` from the project root.

---

## Bot handles

The following Poe bots are used — verify that they are available on your account:

| Bot used in code | Purpose |
|---|---|
| `@ElevenLabs-Music` | Music / audio generation |
| `@ElevenLabs-v2.5-Turbo` | Text-to-speech |
| `@Nano-Banana-2` | Image generation (16:9) |
| `@Sora-2` | Video generation |
| `@GPT-4o` / custom models | Sermon text generation |

If any bot handle is invalid for your account, update the corresponding call in `index.html`.

---

## Notes

- **`/repeat N` images:** The polyfill makes N parallel API calls and fires the handler once per result, matching native Poe behavior.
- **Streaming:** Calls with `stream:true` (e.g., main sermon generation) deliver incremental text updates to the UI as chunks arrive.
- **Attachments:** Audio, image, and video URLs returned by Poe's `file_attachment` SSE events are passed through the polyfill's `result.attachments` array exactly as the original code expects.
- **IndexedDB / Library tab:** Works as-is; no server-side storage is involved.
