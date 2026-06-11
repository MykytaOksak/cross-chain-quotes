# Hosting

This project can be published directly from your own computer with a shared backend so every visitor sees the same site state.

## Vercel hosted Arb dashboard

The Vercel build is a lighter public version:

- `Arb` tab is enabled.
- `Portfolio` tab is visible but intentionally empty.
- `Pendle` is hidden.
- Portfolio wallet scanning is disabled.
- Telegram bot token and chat ID are not stored in `src/config.json`; add them from the frontend settings when you want browser-configured alerts.

Use this build command on Vercel:

```bash
npm run build:hosted
```

The project includes Vercel API routes under `api/`:

- `/api/shared/health`
- `/api/shared/config`
- `/api/shared/arb-snapshot`
- `/api/telegram/send-message`

Quote snapshots need durable storage on Vercel. Connect Vercel KV or Upstash Redis and provide either of these env var pairs:

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

or:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

On Vercel Hobby, Cron Jobs are limited to daily schedules, so this project does not require a cron job. The frontend reads `/api/shared/arb-snapshot`; that route refreshes stale quote snapshots on demand and stores the latest result in Redis/KV.

Do not add Pendle private keys to Vercel for this hosted Arb-only version. Keep `.env.worker` local-only.

## Local-only run

If you do not want to use Cloudflare at all, run the app only on your own computer:

```bash
npm run local:start
```

Then open:

- [http://localhost:4173](http://localhost:4173)

This starts the shared app server and Pendle worker locally, without any public tunnel.

## Local development

If you want hot reload for frontend work, run:

```bash
npm run local:dev
```

Then open:

- [http://localhost:5173](http://localhost:5173)

This starts:

- Vite dev server on `http://localhost:5173`
- shared app API on `http://localhost:4173`
- Pendle worker on `http://localhost:8788`

The frontend keeps using the same shared local backend, but updates instantly after file saves.

## What runs locally

- `app-server` serves the built frontend and shared API routes on `http://localhost:4173`
- `pendle-worker` serves Pendle endpoints on `http://localhost:8788`
- `shared:start` launches both together

## Before you start

1. Create `.env.worker` with at least:

```bash
PENDLE_PRIVATE_KEY=your_private_key_here
PENDLE_WORKER_PORT=8788
```

2. Build the frontend:

```bash
npm run build
```

3. Start the shared stack:

```bash
npm run shared:start
```

Health checks:

- App server: [http://localhost:4173/api/shared/health](http://localhost:4173/api/shared/health)
- Pendle worker: [http://localhost:8788/api/pendle/health](http://localhost:8788/api/pendle/health)

## Quick public URL with Cloudflare Tunnel

Install `cloudflared`, then run:

```bash
cloudflared tunnel --url http://localhost:4173
```

Cloudflare will print a temporary public URL such as `https://random-name.trycloudflare.com`.

## Stable hostname with your own domain

1. Authenticate once:

```bash
cloudflared tunnel login
```

2. Create a tunnel:

```bash
cloudflared tunnel create cross-chain-arb
```

3. Copy [cloudflared/config.example.yml](/Users/mykytaoksak/Downloads/Dev/cross-chain-arb/cloudflared/config.example.yml) to your Cloudflare config location and replace:

- `your-tunnel-id`
- `your-user`
- `arb.your-domain.com`

4. Point DNS:

```bash
cloudflared tunnel route dns cross-chain-arb arb.your-domain.com
```

5. Run the tunnel:

```bash
cloudflared tunnel run cross-chain-arb
```

## Notes

- The site is public only while your computer is on and connected.
- Sleep mode will stop the app.
- Anyone opening the public URL will hit the same backend and see the same shared state.
- For a safer public deployment, move Telegram and other secrets out of client config and keep them only in server env files.
