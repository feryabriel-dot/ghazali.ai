# GHAZALI AI — Drama & Storyboard Studio

A Cloudflare-hosted production workspace with a React studio, Access-protected Worker API, D1 project/job state, an R2-backed media storage abstraction, Queue-driven generation, and a separately hosted FFmpeg renderer. Images, speech, music, and validated MP4 files stay in persistent object storage; D1 stores relational metadata only. A production is marked complete only after required assets pass readiness checks and the renderer reports a decoded MP4 with video, audio, subtitles, and a duration within tolerance.

## What Runs

- Project dashboard with create, rename, duplicate, delete, resume, progress, preview, and validated MP4 download.
- One-click screenplay generation, scene image generation, per-line speech generation, original background music generation, and queued rendering.
- Five-language allowlist shared by frontend and Worker: Bahasa Indonesia, Bahasa Melayu Malaysia, Bahasa Jawa, Bahasa Madura, and English (US). The Worker rejects all other languages.
- Cloudflare Access JWT verification for private project APIs, same-origin checks for writes, per-owner create limits, idempotency keys, persistent D1 jobs, retries, and a single R2 adapter for media writes, reads, existence checks, range responses, and deletion.
- A separate containerized FFmpeg service. It validates and decodes each input, adds image-based motion and scene crossfades, mixes generated music and speech, burns word-highlight subtitles, probes the output, and decodes the final MP4 before returning it.

## Provider Configuration

No AI calls are made until a user starts a production and the corresponding credentials are configured. There are no bundled mock providers or generated placeholders.

- `OPENAI_API_KEY`: story JSON (`gpt-4o-mini`), scene images (`gpt-image-1`), and speech (`gpt-4o-mini-tts`). Calls are server-side. OpenAI pricing and supported voice/language combinations can change; consult current provider documentation and billing.
- `TTS_SUPPORTED_LANGUAGES`: comma-separated subset of the five allowed names. Leave empty until the configured TTS model and voice have been verified for that exact language. The system blocks speech when the requested language is not explicitly enabled; it never substitutes another language. The generated speech API does not provide word-level forced alignment here, so subtitle word timing is estimated from decoded audio duration and is reported as reduced accuracy.
- `REPLICATE_API_TOKEN`: original instrumental background music from Replicate MusicGen. The default model is `meta/musicgen`; generation is required and a missing provider blocks production. Model availability, duration caps, quotas, and pricing are controlled by Replicate and may change.
- `RENDERER_URL` and `RENDERER_TOKEN`: authenticated external FFmpeg renderer. Deploy the `renderer/` container to a host that permits long-running CPU jobs and enough temporary disk. This service is not run inside a Cloudflare Worker.
- `MEDIA_SIGNING_SECRET`: a random secret of at least 32 bytes for short-lived private renderer media URLs. Keep it Worker-only; do not copy it to the renderer host. It is deliberately distinct from `RENDERER_TOKEN`.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`: Cloudflare Access team domain and application audience used to verify user JWTs.
- `APP_ORIGIN`: exact public studio origin. Set the same value as renderer `ASSET_ORIGIN`.

Voice variants are selected per character and a second configured voice is tried if the first fails, without changing the requested language. Provider-specific unsupported-language errors remain errors. Music is mandatory; user uploads and silent fallback tracks are not treated as generated music.

## Local Development

Prerequisites: Node.js 20+, Python 3.12+, FFmpeg/FFprobe for rendering, and provider credentials only if running real production jobs.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Run the API and local Cloudflare bindings in another terminal:

```sh
npx wrangler dev --ip 127.0.0.1 --port 8787
```

The Vite dev server proxies `/api` to port 8787. Local auth bypass is enabled only by `DEV_AUTH_BYPASS=true` and only for a request addressed to `127.0.0.1`; never set this in deployment. Cloudflare local D1/R2/Queues use Wrangler's local state. Run migrations locally with:

```sh
npx wrangler d1 migrations apply ghazali-studio --local
```

Run the renderer locally:

```sh
python -m pip install -r renderer/requirements.txt
ASSET_ORIGIN=http://localhost:5173 RENDERER_TOKEN=replace-with-a-long-random-secret uvicorn renderer.app:app --host 127.0.0.1 --port 8080
```

Set matching `RENDERER_TOKEN` in `.dev.vars`. The local signed asset URL uses Vite's `http://localhost:5173` origin and its `/api` proxy; keep `ASSET_ORIGIN` and `APP_ORIGIN` aligned to that origin.

## Cloudflare Deployment

1. Create a Cloudflare Worker project and connect this repository in GitHub. Install dependencies and build with `npm install && npm run build`.
2. Verify current Cloudflare pricing, free-tier eligibility, and payment-card requirements before provisioning any cloud resource. This repository has not verified those account-specific/current requirements; do not activate billing or create an R2 bucket to proceed. The Worker expects the persistent R2 bucket named in the existing `MEDIA` binding. If it is not already available under terms that meet the zero-cost/no-card requirement, stop deployment here; there is no ephemeral-filesystem fallback or storage migration.

   If your account independently meets those requirements, create the D1 database and queues, then replace `database_id` in `wrangler.toml`. This task does not run these commands or provision resources:

   ```sh
   npx wrangler d1 create ghazali-studio
   npx wrangler queues create ghazali-production
   npx wrangler queues create ghazali-production-dlq
   npx wrangler d1 migrations apply ghazali-studio --remote
   ```

3. Configure the Worker secrets (do not commit secret values):

   ```sh
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put REPLICATE_API_TOKEN
   npx wrangler secret put RENDERER_URL
   npx wrangler secret put RENDERER_TOKEN
   npx wrangler secret put MEDIA_SIGNING_SECRET
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   ```

   Set non-secret Worker variables `APP_ORIGIN` and `TTS_SUPPORTED_LANGUAGES` in the Cloudflare dashboard or `wrangler.toml`. Configure the language list only after checking actual model support. `APP_ORIGIN` must be the exact deployed HTTPS origin.

4. Build and deploy the Worker plus static assets:

   ```sh
   npm install
   npm run deploy
   ```

5. Protect the studio hostname with Cloudflare Access and configure the JWT team domain and application audience above. Add a narrowly scoped Access bypass for `/api/media/*`: those short-lived URLs are separately HMAC-signed and validated by the Worker so the renderer can fetch private objects. Do not bypass any other API path. Keep `MEDIA_SIGNING_SECRET` Worker-only and keep `RENDERER_TOKEN` identical to the renderer host secret.
6. Deploy `renderer/Dockerfile` on a private container host with outbound access to the studio origin. Set `RENDERER_TOKEN` and `ASSET_ORIGIN` on that host. Allow only the Worker to call `/render` where the hosting platform supports network restrictions. Verify `/health` before enabling production.
7. Test a one-minute production with explicitly configured providers before accepting longer projects.

Actual Cloudflare costs and payment-card requirements were not verified for any account in this task. No billing, subscription, bucket, or deployment was activated. The external renderer and commercial AI APIs may incur charges. Do not assume that any service or free allowance is available without payment details; verify it first. This project does not activate billing, guarantee free quotas, or claim unlimited generation. Set provider spend limits with each vendor.

## Tests and Checks

```sh
npm run typecheck
npm test
python -m pip install -r renderer/requirements.txt
npm run test:python
npm run build
```

The automated tests use local domain/SQLite and renderer helper checks; they do not prove external AI provider availability or a full paid end-to-end render. There is no browser automation suite yet. Use a configured staging environment for end-to-end image, voice, music, render, playback, and download acceptance before production use.

## Known Limitations

- AI providers, verified TTS languages, Cloudflare resources, Access, and the renderer are owner-configured. This repository does not ship credentials and cannot establish that an external provider currently supports every allowlisted language. Javanese and Madurese must not be enabled without an explicit provider verification; no unrelated voice is substituted.
- Word timing is estimated from each decoded speech clip, not provider forced alignment. The renderer burns the same subtitle file into the MP4; exact phoneme/word alignment is not guaranteed.
- Camera movement is image-based pan/zoom/crop with crossfades. It is not genuine AI-generated video animation. The renderer and UI identify it as image-based cinematic motion.
- MusicGen availability, model duration, and account limits are external. The renderer loops validated generated music to cover the timeline; no synthetic fallback is used if music generation fails.
- Rendering and media transfer are asynchronous from the user's perspective, but a queue consumer waits on the external renderer request. Very long or high-resolution renders need a production renderer host and queue/runtime limits sized for that workload.
- Private routes depend on correct Cloudflare Access protection and the signed media-path exception. Review Access policies before exposing a deployment.