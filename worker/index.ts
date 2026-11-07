import { isApprovedLanguage, isValidDuration } from '../shared/languages';
import { getReadinessError } from '../shared/readiness';
import { createProviders } from './providers';
import { createMediaStore, mediaResponse, type MediaBucket } from './storage';

type Row = Record<string, unknown>;
type D1Statement = { bind: (...values: unknown[]) => D1Statement; first<T = Row>(): Promise<T | null>; all<T = Row>(): Promise<{ results: T[] }>; run(): Promise<{ success: boolean; meta: { changes: number } }> };
type Database = { prepare: (sql: string) => D1Statement; batch: (statements: D1Statement[]) => Promise<unknown[]> };
type Queue = { send: (body: QueueTask) => Promise<void> };
type QueueTask = { jobId: string; kind: 'story' | 'image' | 'speech' | 'music' | 'render'; ordinal?: number };
type Env = {
  DB: Database; MEDIA: MediaBucket; PRODUCTION_QUEUE: Queue; STATIC: { fetch: (request: Request) => Promise<Response> };
  OPENAI_API_KEY?: string; REPLICATE_API_TOKEN?: string; REPLICATE_MUSIC_MODEL?: string;
  RENDERER_URL?: string; RENDERER_TOKEN?: string; MEDIA_SIGNING_SECRET?: string; APP_ORIGIN?: string;
  ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; DEV_AUTH_BYPASS?: string; TTS_SUPPORTED_LANGUAGES?: string;
};
class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
type Character = { id: string; name: string; appearance: string; wardrobe: string; voiceDescription: string };
type SpokenSegment = { kind: 'narration' | 'dialogue'; characterId: string | null; text: string; emotion: string; sceneIndex: number };
type Scene = { title: string; location: string; visualDescription: string; cameraMovement: string; transition: string; durationSeconds: number; dialogue: { characterId: string; text: string; emotion: string }[]; narration: string };
type Story = { synopsis: string; genre: string; characters: Character[]; scenes: Scene[] };

const VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;
const MOVEMENTS = ['Pan left', 'Pan right', 'Tilt up', 'Tilt down', 'Zoom in', 'Zoom out', 'Dolly in', 'Dolly out', 'Tracking movement', 'Orbit-style movement', 'Static cinematic framing', 'Auto Cinematic'] as const;
const TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'smoothleft', 'smoothright', 'circleopen', 'circleclose', 'cut'] as const;
const LANG_CODE: Record<string, string> = { 'Bahasa Indonesia': 'id', 'Bahasa Melayu Malaysia': 'ms-MY', 'Bahasa Jawa': 'jv', 'Bahasa Madura': 'mad', 'English (US)': 'en-US' };

function json(data: unknown, status = 200, headers?: HeadersInit) { return Response.json(data, { status, headers }); }
function now() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }
function parseJson<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
function safeError(error: unknown) { return error instanceof Error ? error.message.slice(0, 500) : 'Unexpected provider or processing error.'; }
function languageAllowed(value: unknown) { return isApprovedLanguage(value); }
function configuredSpeechLanguages(env: Env) { return (env.TTS_SUPPORTED_LANGUAGES || '').split(',').map((value) => value.trim()).filter(languageAllowed); }
function providers(env: Env) { return createProviders({ openAiKey: env.OPENAI_API_KEY, replicateToken: env.REPLICATE_API_TOKEN, musicModel: env.REPLICATE_MUSIC_MODEL }); }
function b64ToBytes(value: string) { const raw = atob(value); const output = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index); return output; }
function bytesToB64Url(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function b64UrlToBytes(value: string) { return b64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)); }

async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  if (env.DEV_AUTH_BYPASS === 'true' && new URL(request.url).hostname === '127.0.0.1') return 'local-development';
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const [headerPart, claimsPart, signaturePart] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64UrlToBytes(headerPart))) as { kid: string; alg: string };
    const claims = JSON.parse(new TextDecoder().decode(b64UrlToBytes(claimsPart))) as { aud: string[]; exp: number; iss: string; sub: string };
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (header.alg !== 'RS256' || claims.iss !== issuer || !claims.aud.includes(env.ACCESS_AUD) || claims.exp <= Date.now() / 1000 || !claims.sub) return null;
    const certs = await fetch(`${issuer}/cdn-cgi/access/certs`).then((response) => response.json()) as { keys: JsonWebKey[] };
    const jwk = certs.keys.find(
  (key) => (key as JsonWebKey & { kid?: string }).kid === header.kid
);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${headerPart}.${claimsPart}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64UrlToBytes(signaturePart), signed);
    return valid ? claims.sub : null;
  } catch { return null; }
}

async function bodyJson(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be a JSON object.', 400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Request body must be valid JSON.', 400);
  }
}
async function projectForOwner(env: Env, id: string, owner: string) {
  return env.DB.prepare('SELECT * FROM projects WHERE id=? AND owner=?').bind(id, owner).first<Row>();
}
async function jobForOwner(env: Env, id: string, owner: string) {
  return env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner=?').bind(id, owner).first<Row>();
}
async function consumeRateLimit(env: Env, owner: string, maximum: number) {
  const bucket = Math.floor(Date.now() / 60_000);
  await env.DB.prepare(`INSERT INTO rate_limits(owner,bucket,requests) VALUES(?,?,1) ON CONFLICT(owner,bucket) DO UPDATE SET requests=requests+1`).bind(owner, bucket).run();
  const row = await env.DB.prepare('SELECT requests FROM rate_limits WHERE owner=? AND bucket=?').bind(owner, bucket).first<{ requests: number }>();
  await env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(bucket - 10).run();
  return Number(row?.requests || 0) <= maximum;
}
function projectResponse(row: Row) {
  return { id: row.id, title: row.title, language: row.language, durationSeconds: row.duration_seconds, status: row.status, updatedAt: row.updated_at, jobId: row.job_id || undefined, jobStatus: row.job_status || undefined, stage: row.job_stage || undefined, progress: row.job_progress ?? undefined, jobError: row.job_error || undefined };
}
function jobResponse(row: Row) {
  return { id: row.id, projectId: row.project_id, status: row.status, stage: row.stage, progress: row.progress, error: row.error || undefined };
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); } catch (reason) {
      error = reason;
      const status = reason instanceof Error ? reason.message.match(/\((\d{3})\)/)?.[1] : undefined;
      const retryable = !status || status === '429' || Number(status) >= 500;
      if (!retryable || attempt + 1 >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    }
  }
  throw error;
}

function spokenSegments(story: Story): SpokenSegment[] {
  const segments: SpokenSegment[] = [];
  story.scenes.forEach((scene, sceneIndex) => {
    const narration = scene.narration.trim();
    if (narration) segments.push({ kind: 'narration', characterId: null, text: narration, emotion: 'reflective', sceneIndex });
    scene.dialogue.forEach((line) => segments.push({ kind: 'dialogue', characterId: line.characterId, text: line.text.trim(), emotion: line.emotion, sceneIndex }));
  });
  return segments;
}

function validateStory(value: unknown, requestedDuration: number): Story {
  const story = value as Story;
  if (!story || typeof story.synopsis !== 'string' || typeof story.genre !== 'string' || !Array.isArray(story.characters) || !Array.isArray(story.scenes) || !story.scenes.length) throw new Error('Story provider returned an invalid screenplay structure.');
  if (story.scenes.length > 40 || story.characters.length > 12) throw new Error('Generated screenplay exceeds the configured scene or character limit.');
  const ids = new Set(story.characters.map((character) => character.id));
  if (ids.size !== story.characters.length || story.characters.some((character) => !character.name || !character.appearance || !character.wardrobe || !character.voiceDescription)) throw new Error('Generated screenplay has incomplete or duplicate character profiles.');
  let total = 0;
  story.scenes.forEach((scene) => {
    if (!scene.title || !scene.location || !scene.visualDescription || !Array.isArray(scene.dialogue) || typeof scene.narration !== 'string') throw new Error('A generated scene is missing required script or visual details.');
    if (!MOVEMENTS.includes(scene.cameraMovement as (typeof MOVEMENTS)[number])) scene.cameraMovement = 'Auto Cinematic';
    if (!TRANSITIONS.includes(scene.transition as (typeof TRANSITIONS)[number])) scene.transition = 'fade';
    if (!Number.isInteger(scene.durationSeconds) || scene.durationSeconds < 3 || scene.durationSeconds > 120) throw new Error('Generated scene duration is outside safe limits.');
    scene.dialogue.forEach((line) => { if (!ids.has(line.characterId) || !line.text?.trim()) throw new Error('Generated dialogue refers to a missing character or is empty.'); });
    total += scene.durationSeconds;
  });
  const durationDifference = requestedDuration - total;
  if (Math.abs(durationDifference) > Math.max(10, requestedDuration * 0.1)) throw new Error('Generated scene durations do not match the requested final duration.');
  const finalScene = story.scenes[story.scenes.length - 1];
  finalScene.durationSeconds += durationDifference;
  if (finalScene.durationSeconds < 3 || finalScene.durationSeconds > 120) throw new Error('Generated scene durations cannot be adjusted to the requested runtime safely.');
  if (!spokenSegments(story).length) throw new Error('Generated screenplay has no speech segments.');
  if (spokenSegments(story).length > 500) throw new Error('Generated screenplay contains more speech segments than the renderer supports.');
  return story;
}

async function generateStory(env: Env, project: Row): Promise<Story> {
  const duration = Number(project.duration_seconds);
  const requestedScenes = Math.max(2, Math.min(40, Math.ceil(duration / 30)));
  const provider = providers(env);
  const response = await retry(() => provider.openAi('chat/completions', {
    model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0.8,
    messages: [
      { role: 'system', content: 'You are a professional screenwriter. Return valid JSON only, in the requested language. Create original, coherent, production-ready stories. Never change the requested language.' },
      { role: 'user', content: `Create an original drama titled "${String(project.title).replaceAll('"', '')}" in ${project.language}. Total runtime exactly ${duration} seconds. Return JSON with keys synopsis, genre, characters, scenes. Characters: array of {id,name,appearance,wardrobe,voiceDescription}. Scenes: exactly ${requestedScenes} entries with {title,location,visualDescription,cameraMovement,transition,durationSeconds,narration,dialogue}. Dialogue entries are {characterId,text,emotion}. Every scene needs concise narration and visual/camera direction. Scene durations must be integers >= 3, total exactly ${duration}. Dialogue and narration should fit the time naturally; use ${project.language} only. Give all scenes a consistent look; repeat stable character appearance and wardrobe details in visual descriptions. cameraMovement must be one of: ${MOVEMENTS.join(', ')}. transition must be one of: ${TRANSITIONS.join(', ')}. Keep lines concise enough to be spoken within each scene.` },
    ],
  }));
  const envelope = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = envelope.choices?.[0]?.message?.content;
  if (!content) throw new Error('Story provider returned an empty screenplay.');
  return validateStory(JSON.parse(content), duration);
}

async function createAsset(env: Env, job: Row, kind: string, ordinal: number, metadata: Record<string, unknown>) {
  const stamp = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO assets(id,job_id,project_id,kind,ordinal,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?)`)
    .bind(newId(), job.id, job.project_id, kind, ordinal, JSON.stringify(metadata), stamp, stamp).run();
}

async function prepareAssets(env: Env, job: Row, project: Row, story: Story) {
  const assets = story.scenes.map((scene, index) => createAsset(env, job, 'image', index, { sceneIndex: index, cameraMovement: scene.cameraMovement }));
  const segments = spokenSegments(story);
  segments.forEach((segment, index) => assets.push(createAsset(env, job, 'speech', index, segment)));
  assets.push(createAsset(env, job, 'music', 0, { durationSeconds: project.duration_seconds, genre: story.genre }));
  await Promise.all(assets);
  const tasks: QueueTask[] = [
    ...story.scenes.map((_, ordinal) => ({ jobId: String(job.id), kind: 'image' as const, ordinal })),
    ...segments.map((_, ordinal) => ({ jobId: String(job.id), kind: 'speech' as const, ordinal })),
    { jobId: String(job.id), kind: 'music', ordinal: 0 },
  ];
  await Promise.all(tasks.map((task) => env.PRODUCTION_QUEUE.send(task)));
}

async function claimAsset(env: Env, jobId: string, kind: string, ordinal: number) {
  const updated = await env.DB.prepare(`UPDATE assets SET status='generating',updated_at=? WHERE job_id=? AND kind=? AND ordinal=? AND status IN ('pending','failed')`).bind(now(), jobId, kind, ordinal).run();
  return updated.meta.changes === 1;
}

async function saveAsset(env: Env, job: Row, kind: string, ordinal: number, bytes: ArrayBuffer, contentType: string, metadata?: Record<string, unknown>) {
  if (!bytes.byteLength || bytes.byteLength > 30 * 1024 * 1024) throw new Error(`${kind} asset is empty or exceeds the 30 MB asset limit.`);
  const key = `${job.project_id}/${job.id}/${kind}/${ordinal}`;
  await createMediaStore(env.MEDIA).put(key, bytes, contentType);
  await env.DB.prepare(`UPDATE assets SET status='ready',object_key=?,content_type=?,byte_size=?,metadata_json=CASE WHEN ? IS NULL THEN metadata_json ELSE ? END,error=NULL,updated_at=? WHERE job_id=? AND kind=? AND ordinal=?`)
    .bind(key, contentType, bytes.byteLength, metadata ? JSON.stringify(metadata) : null, metadata ? JSON.stringify(metadata) : null, now(), job.id, kind, ordinal).run();
}

async function restoreExistingAsset(env: Env, job: Row, kind: string, ordinal: number) {
  const key = `${job.project_id}/${job.id}/${kind}/${ordinal}`;
  const stored = await createMediaStore(env.MEDIA).head(key);
  if (!stored || stored.size < 100) return false;
  const asset = await env.DB.prepare('SELECT content_type FROM assets WHERE job_id=? AND kind=? AND ordinal=?').bind(job.id, kind, ordinal).first<{ content_type: string | null }>();
  const contentType = asset?.content_type || (kind === 'image' ? 'image/png' : kind === 'speech' || kind === 'music' ? 'audio/mpeg' : 'application/octet-stream');
  await env.DB.prepare(`UPDATE assets SET status='ready',object_key=?,content_type=?,byte_size=?,error=NULL,updated_at=? WHERE job_id=? AND kind=? AND ordinal=?`)
    .bind(key, contentType, stored.size, now(), job.id, kind, ordinal).run();
  return true;
}

async function doImage(env: Env, job: Row, project: Row, story: Story, ordinal: number) {
  const scene = story.scenes[ordinal];
  if (!scene) throw new Error(`Image scene ${ordinal + 1} is missing from the screenplay.`);
  const claim = await claimAsset(env, String(job.id), 'image', ordinal);
  if (!claim) return;
  try {
    if (await restoreExistingAsset(env, job, 'image', ordinal)) return;
    const provider = providers(env);
    const response = await retry(() => provider.openAi('images/generations', { model: 'gpt-image-1', size: '1536x1024', quality: 'medium', n: 1, output_format: 'png', prompt: `Generate one cinematic 16:9 drama film still. Story: ${project.title}. Scene ${ordinal + 1}: ${scene.visualDescription}. Location: ${scene.location}. Camera: ${scene.cameraMovement}. Character continuity is essential; use these exact character appearance and wardrobe references: ${story.characters.map((character) => `${character.name}: ${character.appearance}; clothing: ${character.wardrobe}`).join(' | ')}. No lettering, no captions, no collage.` }));
    const data = await response.json() as { data?: { b64_json?: string }[] };
    const encoded = data.data?.[0]?.b64_json;
    if (!encoded) throw new Error(`Image provider returned no scene image for scene ${ordinal + 1}.`);
    const bytes = b64ToBytes(encoded);
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error(`Scene ${ordinal + 1} image is not a valid PNG.`);
    await saveAsset(env, job, 'image', ordinal, bytes.buffer, 'image/png', { sceneIndex: ordinal });
  } catch (error) { await markAssetFailed(env, job, 'image', ordinal, error); throw error; }
}

async function doSpeech(env: Env, job: Row, project: Row, story: Story, ordinal: number) {
  const supported = configuredSpeechLanguages(env);
  const language = String(project.language);
  if (!languageAllowed(language) || !supported.includes(language)) throw new Error(`Speech generation for ${language} is unavailable. Confirm this exact language is supported by your configured voice provider, then add it to TTS_SUPPORTED_LANGUAGES. No other language or accent will be substituted.`);
  const segment = spokenSegments(story)[ordinal];
  if (!segment) throw new Error(`Speech segment ${ordinal + 1} is missing from the screenplay.`);
  const claim = await claimAsset(env, String(job.id), 'speech', ordinal);
  if (!claim) return;
  try {
    if (await restoreExistingAsset(env, job, 'speech', ordinal)) return;
    const characterIndex = story.characters.findIndex((character) => character.id === segment.characterId);
    const preferred = segment.kind === 'narration' ? VOICES[0] : VOICES[Math.max(0, characterIndex) % VOICES.length];
    const voiceOptions = [preferred, VOICES[(Math.max(0, characterIndex) + 1) % VOICES.length]];
    let response: Response | undefined;
    let voiceError: unknown;
    const provider = providers(env);
    for (const voice of voiceOptions) {
      try {
        response = await retry(() => provider.openAi('audio/speech', { model: 'gpt-4o-mini-tts', voice, response_format: 'mp3', input: segment.text, instructions: `Speak naturally in ${language} (${LANG_CODE[language]}). Preserve the requested language and pronunciation; do not switch languages. Character delivery: ${story.characters[characterIndex]?.voiceDescription || 'calm narrator'}. Emotion: ${segment.emotion}.` }));
        break;
      } catch (error) {
        voiceError = error;
        const message = safeError(error);
        if (!/voice/i.test(message) || !/(unsupported|not supported|invalid|unavailable)/i.test(message)) throw error;
      }
    }
    if (!response) throw new Error(`No configured voice could produce this segment in ${language}: ${safeError(voiceError)}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 100) throw new Error(`Speech provider returned an invalid recording for segment ${ordinal + 1}.`);
    await saveAsset(env, job, 'speech', ordinal, bytes, 'audio/mpeg', segment as unknown as Record<string, unknown>);
  } catch (error) { await markAssetFailed(env, job, 'speech', ordinal, error); throw error; }
}

async function doMusic(env: Env, job: Row, project: Row, story: Story) {
  if (!env.REPLICATE_API_TOKEN) throw new Error('Original AI music is unavailable: set REPLICATE_API_TOKEN to enable Replicate MusicGen. The production is blocked; no placeholder or silent track is used.');
  const claim = await claimAsset(env, String(job.id), 'music', 0);
  if (!claim) return;
  try {
    if (await restoreExistingAsset(env, job, 'music', 0)) return;
    const prompt = `Original instrumental cinematic ${story.genre} score. Match emotional progression across ${story.scenes.map((scene) => scene.title).join(', ')}. No vocals, no recognizable melodies.`;
    const adapter = providers(env);
    const asset = await env.DB.prepare('SELECT metadata_json FROM assets WHERE job_id=? AND kind=\'music\' AND ordinal=0').bind(job.id).first<{ metadata_json: string }>();
    let metadata = parseJson<Record<string, unknown>>(asset?.metadata_json, {});
    let predictionId = typeof metadata.predictionId === 'string' ? metadata.predictionId : '';
    if (!predictionId) {
      predictionId = await adapter.startMusic(prompt, Number(project.duration_seconds), `${job.id}:music:0`);
      metadata = { ...metadata, predictionId };
      await env.DB.prepare('UPDATE assets SET metadata_json=?,updated_at=? WHERE job_id=? AND kind=\'music\' AND ordinal=0').bind(JSON.stringify(metadata), now(), job.id).run();
    }
    const generated = await adapter.completeMusic(predictionId);
    await saveAsset(env, job, 'music', 0, generated.bytes, generated.contentType, { provider: 'replicate/musicgen' });
  } catch (error) {
    await markAssetFailed(env, job, 'music', 0, error);
    if (error instanceof Error && error.message.startsWith('Music generation ended with status')) {
      const current = await env.DB.prepare('SELECT metadata_json FROM assets WHERE job_id=? AND kind=\'music\' AND ordinal=0').bind(job.id).first<{ metadata_json: string }>();
      const metadata = parseJson<Record<string, unknown>>(current?.metadata_json, {});
      delete metadata.predictionId;
      await env.DB.prepare('UPDATE assets SET metadata_json=? WHERE job_id=? AND kind=\'music\' AND ordinal=0').bind(JSON.stringify(metadata), job.id).run();
    }
    throw error;
  }
}

async function markAssetFailed(env: Env, job: Row, kind: string, ordinal: number, error: unknown) {
  await env.DB.prepare(`UPDATE assets SET status='failed',error=?,updated_at=? WHERE job_id=? AND kind=? AND ordinal=?`).bind(safeError(error), now(), job.id, kind, ordinal).run();
}

async function updateProgress(env: Env, job: Row, stage: string) {
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready FROM assets WHERE job_id=? AND kind!='video'`).bind(job.id).first<{ total: number; ready: number }>();
  const progress = Math.min(89, 15 + Math.floor(74 * (Number(counts?.ready || 0) / Math.max(1, Number(counts?.total || 1)))));
  await env.DB.prepare(`UPDATE jobs SET status='processing',stage=?,progress=?,updated_at=? WHERE id=?`).bind(stage, progress, now(), job.id).run();
  await env.DB.prepare(`UPDATE projects SET status='processing',updated_at=? WHERE id=?`).bind(now(), job.project_id).run();
}

async function signMediaUrl(env: Env, objectKey: string) {
  if (!env.MEDIA_SIGNING_SECRET || new TextEncoder().encode(env.MEDIA_SIGNING_SECRET).byteLength < 32 || !env.APP_ORIGIN) throw new Error('Renderer media signing is not configured. Set a MEDIA_SIGNING_SECRET of at least 32 bytes and APP_ORIGIN.');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const message = `${objectKey}\n${expires}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.MEDIA_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesToB64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return `${env.APP_ORIGIN.replace(/\/$/, '')}/api/media/${encodeURIComponent(objectKey)}?expires=${expires}&signature=${signature}`;
}

async function readiness(env: Env, job: Row) {
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(job.project_id).first<Row>();
  if (!project?.story_json) return { ok: false, error: 'Story and scene breakdown are missing.' };
  const story = parseJson<Story | null>(project.story_json, null);
  if (!story?.scenes?.length) return { ok: false, error: 'Story JSON is missing or invalid.' };
  const rows = (await env.DB.prepare('SELECT * FROM assets WHERE job_id=? AND kind!=\'video\' ORDER BY kind,ordinal').bind(job.id).all<Row>()).results;
  const expectedSpeech = spokenSegments(story).length;
  const error = getReadinessError(story, expectedSpeech, rows.map((asset) => ({ kind: String(asset.kind), ordinal: Number(asset.ordinal), status: String(asset.status), object_key: asset.object_key ? String(asset.object_key) : null, error: asset.error ? String(asset.error) : null })), Number(project.duration_seconds));
  if (error) return { ok: false, error };
  for (const asset of rows.filter((item) => item.status === 'ready')) {
    const stored = await createMediaStore(env.MEDIA).head(String(asset.object_key));
    if (!stored || stored.size < 100) return { ok: false, error: `Render blocked: ${String(asset.kind)} ${Number(asset.ordinal) + 1} cannot be read from object storage.` };
  }
  return { ok: true, project, story, rows };
}

async function maybeQueueRender(env: Env, job: Row) {
  const check = await readiness(env, job);
  if (!check.ok) return;
  const claim = await env.DB.prepare(`UPDATE jobs SET render_claimed=1,stage='Preparing validated timeline',updated_at=? WHERE id=? AND render_claimed=0`).bind(now(), job.id).run();
  if (claim.meta.changes) await env.PRODUCTION_QUEUE.send({ jobId: String(job.id), kind: 'render' });
}

async function render(env: Env, job: Row) {
  if (!env.RENDERER_URL || !env.RENDERER_TOKEN) throw new Error('Video rendering is unavailable. Configure RENDERER_URL and RENDERER_TOKEN for the separate FFmpeg renderer.');
  const check = await readiness(env, job);
  if (!check.ok || !check.project || !check.story || !check.rows) throw new Error(check.error || 'Render readiness check failed.');
  const assets = check.rows;
  const imageAssets = assets.filter((asset) => asset.kind === 'image');
  const speechAssets = assets.filter((asset) => asset.kind === 'speech');
  const musicAsset = assets.find((asset) => asset.kind === 'music');
  const speechMetadata = speechAssets.map((asset) => parseJson<SpokenSegment>(asset.metadata_json, { kind: 'narration', sceneIndex: 0, text: '', emotion: '', characterId: null }));
  const manifest = {
    jobId: job.id,
    project: { title: check.project.title, durationSeconds: check.project.duration_seconds, language: check.project.language },
    story: check.story,
    scenes: check.story.scenes.map((scene, index) => ({ ...scene, imageUrl: signMediaUrl(env, String(imageAssets.find((asset) => Number(asset.ordinal) === index)?.object_key)) })),
    speech: speechAssets.map((asset, index) => ({ ...speechMetadata[index], audioUrl: signMediaUrl(env, String(asset.object_key)) })),
    musicUrl: await signMediaUrl(env, String(musicAsset?.object_key)),
  };
  const resolvedManifest = { ...manifest, scenes: await Promise.all(manifest.scenes.map(async (scene) => ({ ...scene, imageUrl: await scene.imageUrl }))), speech: await Promise.all(manifest.speech.map(async (segment) => ({ ...segment, audioUrl: await segment.audioUrl }))) };
  const response = await fetch(`${env.RENDERER_URL.replace(/\/$/, '')}/render`, { method: 'POST', headers: { authorization: `Bearer ${env.RENDERER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(resolvedManifest), signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`FFmpeg renderer failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const reportHeader = response.headers.get('x-render-validation');
  if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4' || !reportHeader) throw new Error('Renderer returned no MP4 validation report; output is rejected.');
  let report: { container: boolean; videoDecoded: boolean; audioDecoded: boolean; subtitles: boolean; durationSeconds: number };
  try { report = JSON.parse(new TextDecoder().decode(b64UrlToBytes(reportHeader))) as typeof report; } catch { throw new Error('Renderer validation report is invalid.'); }
  const expected = Number(check.project.duration_seconds);
  if (!report.container || !report.videoDecoded || !report.audioDecoded || !report.subtitles || !Number.isFinite(report.durationSeconds) || Math.abs(report.durationSeconds - expected) > Math.max(12, expected * 0.12)) throw new Error('Final MP4 validation failed: container, decoded video/audio, subtitles, or duration check did not pass.');
  if (!response.body) throw new Error('Renderer returned no MP4 byte stream.');
  const reader = response.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixSize = 0;
  while (prefixSize < 1024) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('Renderer MP4 ended before its container header.');
    prefixChunks.push(chunk.value);
    prefixSize += chunk.value.byteLength;
  }
  const prefix = new Uint8Array(prefixSize);
  let prefixOffset = 0;
  for (const chunk of prefixChunks) { prefix.set(chunk, prefixOffset); prefixOffset += chunk.byteLength; }
  if (String.fromCharCode(...prefix.slice(4, 8)) !== 'ftyp') throw new Error('Renderer output is not a genuine MP4 container.');
  let prefixSent = false;
  const videoStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) { controller.enqueue(prefix); prefixSent = true; return; }
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel() { void reader.cancel(); },
  });
  const key = `${job.project_id}/${job.id}/video/final.mp4`;
  const storage = createMediaStore(env.MEDIA);
  await storage.put(key, videoStream, 'video/mp4');
  const videoObject = await storage.head(key);
  if (!videoObject || videoObject.size < 1024) throw new Error('Stored MP4 failed its object storage size check.');
  await env.DB.prepare(`INSERT INTO assets(id,job_id,project_id,kind,ordinal,status,object_key,content_type,byte_size,metadata_json,created_at,updated_at) VALUES(?,?,?,'video',0,'ready',?,'video/mp4',?,?,?,?) ON CONFLICT(job_id,kind,ordinal) DO UPDATE SET status='ready',object_key=excluded.object_key,content_type=excluded.content_type,byte_size=excluded.byte_size,metadata_json=excluded.metadata_json,error=NULL,updated_at=excluded.updated_at`)
    .bind(newId(), job.id, job.project_id, key, videoObject.size, JSON.stringify(report), now(), now()).run();
  await env.DB.prepare(`UPDATE jobs SET status='complete',stage='PRODUCTION COMPLETE — READY TO DOWNLOAD',progress=100,error=NULL,updated_at=? WHERE id=?`).bind(now(), job.id).run();
  await env.DB.prepare(`UPDATE projects SET status='complete',updated_at=? WHERE id=?`).bind(now(), job.project_id).run();
}

async function handleTask(env: Env, task: QueueTask) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(task.jobId).first<Row>();
  if (!job || job.status === 'complete' || job.status === 'failed') return;
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(job.project_id).first<Row>();
  if (!project) throw new Error('Production project no longer exists.');
  if (task.kind === 'story') {
    if (project.story_json) {
      await prepareAssets(env, job, project, parseJson<Story>(project.story_json, {} as Story));
      return;
    }
    await updateProgress(env, job, 'Generating original story and screenplay');
    const story = await generateStory(env, project);
    await env.DB.prepare('UPDATE projects SET story_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(story), now(), project.id).run();
    await env.DB.prepare(`UPDATE jobs SET stage='Preparing scenes and dialogue',progress=15,updated_at=? WHERE id=?`).bind(now(), job.id).run();
    await prepareAssets(env, job, project, story);
    return;
  }
  if (task.kind === 'render') {
    await env.DB.prepare(`UPDATE jobs SET stage='Rendering and validating MP4',updated_at=? WHERE id=?`).bind(now(), job.id).run();
    await render(env, job);
    return;
  }
  const story = parseJson<Story | null>(project.story_json, null);
  if (!story) throw new Error('Story must be generated before media assets.');
  await updateProgress(env, job, task.kind === 'image' ? 'Generating cinematic scene images' : task.kind === 'speech' ? 'Generating dialogue and narration' : 'Generating original background music');
  if (task.kind === 'image') await doImage(env, job, project, story, Number(task.ordinal));
  else if (task.kind === 'speech') await doSpeech(env, job, project, story, Number(task.ordinal));
  else await doMusic(env, job, project, story);
  const refreshed = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first<Row>();
  if (refreshed) await maybeQueueRender(env, refreshed);
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.STATIC.fetch(request);
  if (url.pathname.startsWith('/api/media/')) {
    if (request.method !== 'GET') return json({ error: 'Signed media links support GET only.' }, 405, { allow: 'GET' });
    let key: string;
    try { key = decodeURIComponent(url.pathname.slice('/api/media/'.length)); }
    catch { return json({ error: 'Invalid media signature.' }, 403); }
    const expires = Number(url.searchParams.get('expires'));
    const signature = url.searchParams.get('signature') || '';
    if (!env.MEDIA_SIGNING_SECRET || new TextEncoder().encode(env.MEDIA_SIGNING_SECRET).byteLength < 32 || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !Number.isSafeInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + 3610) return json({ error: 'Invalid or expired media signature.' }, 403);
    const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.MEDIA_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', hmac, b64UrlToBytes(signature), new TextEncoder().encode(`${key}\n${expires}`));
    if (!valid) return json({ error: 'Invalid media signature.' }, 403);
    const response = await mediaResponse(createMediaStore(env.MEDIA), key, {
      disposition: 'inline',
      rangeHeader: request.headers.get('Range') || undefined,
    });
    return response || json({ error: 'Media object not found.' }, 404);
  }
  const owner = await verifyAccess(request, env);
  if (!owner) return json({ error: 'Sign in through the configured Cloudflare Access application.' }, 401);
  if (['POST', 'PATCH', 'DELETE'].includes(request.method) && request.headers.get('Origin') !== env.APP_ORIGIN) return json({ error: 'Cross-origin project requests are not allowed.' }, 403);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

  if (path === '/projects' && request.method === 'GET') {
    const rows = (await env.DB.prepare(`SELECT p.*,(SELECT id FROM jobs WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) AS job_id,(SELECT status FROM jobs WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) AS job_status,(SELECT stage FROM jobs WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) AS job_stage,(SELECT progress FROM jobs WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) AS job_progress,(SELECT error FROM jobs WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) AS job_error FROM projects p WHERE p.owner=? ORDER BY p.updated_at DESC LIMIT 100`).bind(owner).all<Row>()).results;
    return json({ projects: rows.map(projectResponse) });
  }
  if (path === '/projects' && request.method === 'POST') {
    if (!await consumeRateLimit(env, owner, 10)) return json({ error: 'Project creation limit reached. Try again in a minute.' }, 429);
    const body = await bodyJson(request); const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 100 || !languageAllowed(body.language) || !isValidDuration(body.durationSeconds)) return json({ error: 'Project title, supported language, or duration is invalid.' }, 400);
    const id = newId(); const stamp = now();
    await env.DB.prepare(`INSERT INTO projects(id,owner,title,language,duration_seconds,status,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)`).bind(id, owner, title, body.language, body.durationSeconds, stamp, stamp).run();
    const project = await projectForOwner(env, id, owner);
    return json({ project: projectResponse(project!) }, 201);
  }
  if (path === '/projects/produce' && request.method === 'POST') {
    const body = await bodyJson(request); const title = typeof body.title === 'string' ? body.title.trim() : '';
    const durationSeconds = Number(body.durationSeconds);
    if (!title || title.length > 100 || !languageAllowed(body.language) || !isValidDuration(durationSeconds)) return json({ error: 'Provide a title, one of the five supported languages, and a duration between 1 and 20 minutes.' }, 400);
    const requestKey = request.headers.get('idempotency-key');
    if (!requestKey || requestKey.length > 100) return json({ error: 'An Idempotency-Key is required to prevent duplicate production jobs.' }, 400);
    const prior = await env.DB.prepare('SELECT * FROM jobs WHERE owner=? AND request_key=?').bind(owner, requestKey).first<Row>();
    if (prior) {
      const project = await projectForOwner(env, String(prior.project_id), owner);
      return json({ project: projectResponse(project!), job: jobResponse(prior) });
    }
    if (!await consumeRateLimit(env, owner, 2)) return json({ error: 'Production limit reached. Try again in a minute.' }, 429);
    const activeJob = await env.DB.prepare(`SELECT id FROM jobs WHERE owner=? AND status IN ('queued','processing') LIMIT 1`).bind(owner).first<Row>();
    if (activeJob) return json({ error: 'You already have a production in progress. Resume it or wait for completion before starting another paid production.' }, 409);
    if (!env.OPENAI_API_KEY) return json({ error: 'Story, image, and speech generation are unavailable. Configure OPENAI_API_KEY before starting production.' }, 503);
    const supported = configuredSpeechLanguages(env);
    if (!supported.includes(body.language)) {
      return json({
        error: `Speech provider has not been confirmed for ${String(body.language)}. Add this exact approved language to TTS_SUPPORTED_LANGUAGES only after verifying provider support.`,
      }, 503);
    }

    if (!env.REPLICATE_API_TOKEN) return json({ error: 'Original background music is unavailable. Configure REPLICATE_API_TOKEN; the production cannot proceed without real generated music.' }, 503);
    if (!env.RENDERER_URL || !env.RENDERER_TOKEN) return json({ error: 'MP4 rendering is unavailable. Configure the external FFmpeg renderer before starting production.' }, 503);
    if (!env.MEDIA_SIGNING_SECRET || new TextEncoder().encode(env.MEDIA_SIGNING_SECRET).byteLength < 32) return json({ error: 'Private renderer media access is unavailable. Configure a MEDIA_SIGNING_SECRET of at least 32 bytes before starting production.' }, 503);
    const projectId = newId(); const jobId = newId(); const stamp = now();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO projects(id,owner,title,language,duration_seconds,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)`).bind(projectId, owner, title, body.language, durationSeconds, stamp, stamp),
        env.DB.prepare(`INSERT INTO jobs(id,project_id,owner,status,stage,progress,request_key,created_at,updated_at) VALUES(?,?,?,'queued','Queued for story generation',0,?,?,?)`).bind(jobId, projectId, owner, requestKey, stamp, stamp),
      ]);
    } catch (error) {
      const concurrent = await env.DB.prepare('SELECT * FROM jobs WHERE owner=? AND request_key=?').bind(owner, requestKey).first<Row>();
      if (!concurrent) throw error;
      const existingProject = await projectForOwner(env, String(concurrent.project_id), owner);
      return json({ project: projectResponse(existingProject!), job: jobResponse(concurrent) });
    }
    try { await env.PRODUCTION_QUEUE.send({ jobId, kind: 'story' }); }
    catch (error) {
      await env.DB.prepare(`UPDATE jobs SET status='failed',stage='Queue dispatch failed',error=?,updated_at=? WHERE id=?`).bind(safeError(error), now(), jobId).run();
      await env.DB.prepare(`UPDATE projects SET status='failed',updated_at=? WHERE id=?`).bind(now(), projectId).run();
    }
    return json({ project: projectResponse((await projectForOwner(env, projectId, owner))!), job: jobResponse((await jobForOwner(env, jobId, owner))!) }, 202);
  }

  const download = path.match(/^\/projects\/([^/]+)\/download$/);
  if (download && request.method === 'GET') {
    const project = await projectForOwner(env, download[1], owner);
    if (!project) return json({ error: 'Project not found.' }, 404);
    const asset = await env.DB.prepare(`SELECT a.* FROM assets a JOIN jobs j ON j.id=a.job_id WHERE a.project_id=? AND j.status='complete' AND a.kind='video' AND a.status='ready' ORDER BY a.created_at DESC LIMIT 1`).bind(project.id).first<Row>();
    if (!asset?.object_key) return json({ error: 'No validated MP4 is available for this project.' }, 409);
    const response = await mediaResponse(createMediaStore(env.MEDIA), String(asset.object_key), {
      contentType: 'video/mp4',
      disposition: `attachment; filename="${String(project.title).replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4"`,
      rangeHeader: request.headers.get('Range') || undefined,
    });
    return response || json({ error: 'Validated MP4 is missing from object storage.' }, 410);
  }
  const preview = path.match(/^\/projects\/([^/]+)\/preview$/);
  if (preview && request.method === 'GET') {
    const project = await projectForOwner(env, preview[1], owner);
    if (!project) return json({ error: 'Project not found.' }, 404);
    const asset = await env.DB.prepare(`SELECT a.* FROM assets a JOIN jobs j ON j.id=a.job_id WHERE a.project_id=? AND j.status='complete' AND a.kind='video' AND a.status='ready' ORDER BY a.created_at DESC LIMIT 1`).bind(project.id).first<Row>();
    if (!asset?.object_key) return json({ error: 'No validated MP4 is available for preview.' }, 409);
    const response = await mediaResponse(createMediaStore(env.MEDIA), String(asset.object_key), {
      contentType: 'video/mp4',
      disposition: 'inline',
      rangeHeader: request.headers.get('Range') || undefined,
    });
    return response || json({ error: 'Validated MP4 is missing from object storage.' }, 410);
  }
  const assetMatch = path.match(/^\/assets\/([^/]+)$/);
  if (assetMatch && request.method === 'GET') {
    const asset = await env.DB.prepare(`SELECT a.* FROM assets a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND p.owner=? AND a.status='ready'`).bind(assetMatch[1], owner).first<Row>();
    if (!asset?.object_key) return json({ error: 'Asset not found or not validated.' }, 404);
    const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    const response = await mediaResponse(createMediaStore(env.MEDIA), String(asset.object_key), {
      contentType: String(asset.content_type || 'application/octet-stream'),
      disposition,
      rangeHeader: request.headers.get('Range') || undefined,
    });
    return response || json({ error: 'Asset is missing from object storage.' }, 410);
  }
  const resume = path.match(/^\/jobs\/([^/]+)\/resume$/);
  if (resume && request.method === 'POST') {
    const job = await jobForOwner(env, resume[1], owner);
    if (!job) return json({ error: 'Job not found.' }, 404);
    const project = await projectForOwner(env, String(job.project_id), owner);
    if (!project) return json({ error: 'Project not found.' }, 404);
    if (job.status === 'queued' || job.status === 'processing') return json({ job: jobResponse(job) }, 202);
    if (job.status !== 'failed') return json({ error: 'Only failed productions can be resumed.' }, 409);
    await env.DB.prepare(`UPDATE jobs SET status='queued',stage='Resuming unfinished production',error=NULL,render_claimed=0,updated_at=? WHERE id=?`).bind(now(), job.id).run();
    await env.DB.prepare(`UPDATE projects SET status='queued',updated_at=? WHERE id=?`).bind(now(), project.id).run();
    try {
      if (!project.story_json) await env.PRODUCTION_QUEUE.send({ jobId: String(job.id), kind: 'story' });
      else {
        const story = parseJson<Story>(project.story_json, {} as Story);
        await env.DB.prepare(`UPDATE assets SET status='pending',error=NULL,updated_at=? WHERE job_id=? AND status='generating'`).bind(now(), job.id).run();
        await prepareAssets(env, job, project, story);
        const currentJob = await jobForOwner(env, String(job.id), owner);
        if (currentJob) await maybeQueueRender(env, currentJob);
      }
    } catch (error) {
      const description = safeError(error);
      await env.DB.prepare(`UPDATE jobs SET status='failed',stage='Resume dispatch failed',error=?,updated_at=? WHERE id=?`).bind(description, now(), job.id).run();
      await env.DB.prepare(`UPDATE projects SET status='failed',updated_at=? WHERE id=?`).bind(now(), project.id).run();
      return json({ error: `Resume dispatch failed: ${description}` }, 503);
    }
    const refreshed = await jobForOwner(env, String(job.id), owner);
    return json({ job: jobResponse(refreshed!) }, 202);
  }
  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === 'GET') {
    const job = await jobForOwner(env, jobMatch[1], owner);
    return job ? json({ job: jobResponse(job) }) : json({ error: 'Job not found.' }, 404);
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/(duplicate))?$/);
  if (projectMatch) {
    const [, id, action] = projectMatch;
    const project = await projectForOwner(env, id, owner);
    if (!project) return json({ error: 'Project not found.' }, 404);
    if (action === 'duplicate' && request.method === 'POST') {
      const newProjectId = newId(); const stamp = now();
      await env.DB.prepare(`INSERT INTO projects(id,owner,title,language,duration_seconds,status,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)`).bind(newProjectId, owner, `${String(project.title).slice(0, 90)} copy`, project.language, project.duration_seconds, stamp, stamp).run();
      const copy = await projectForOwner(env, newProjectId, owner);
      return json({ project: projectResponse(copy!) }, 201);
    }
    if (!action && request.method === 'GET') {
      const story = parseJson<Story | null>(project.story_json, null);
      const jobs = (await env.DB.prepare('SELECT id,status,stage,progress,error,created_at,updated_at FROM jobs WHERE project_id=? AND owner=? ORDER BY created_at DESC').bind(id, owner).all<Row>()).results;
      const assets = (await env.DB.prepare('SELECT id,job_id,kind,ordinal,status,content_type,byte_size,metadata_json,error,created_at,updated_at FROM assets WHERE project_id=? ORDER BY created_at DESC,kind,ordinal').bind(id).all<Row>()).results;
      return json({
        project: projectResponse(project), story,
        jobs: jobs.map((job) => ({ id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error, createdAt: job.created_at, updatedAt: job.updated_at })),
        assets: assets.map((asset) => ({ id: asset.id, kind: asset.kind, ordinal: asset.ordinal, status: asset.status, content_type: asset.content_type, byte_size: asset.byte_size, error: asset.error, metadata: parseJson(asset.metadata_json, {}) })),
      });
    }
    if (request.method === 'PATCH') {
      const body = await bodyJson(request); const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 100) return json({ error: 'Title must contain 1 to 100 characters.' }, 400);
      await env.DB.prepare('UPDATE projects SET title=?,updated_at=? WHERE id=? AND owner=?').bind(title, now(), id, owner).run();
      return json({ project: projectResponse((await projectForOwner(env, id, owner))!) });
    }
    if (request.method === 'DELETE') {
      const keys = (await env.DB.prepare('SELECT object_key FROM assets WHERE project_id=? AND object_key IS NOT NULL').bind(id).all<{ object_key: string }>()).results.map((asset) => asset.object_key);
      if (keys.length) await createMediaStore(env.MEDIA).delete(keys);
      await env.DB.prepare('DELETE FROM projects WHERE id=? AND owner=?').bind(id, owner).run();
      return json({ deleted: true });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await fetchHandler(request, env); }
    catch (error) {
      console.error('api_error', safeError(error));
      return json({ error: safeError(error) }, error instanceof RequestError ? error.status : 500);
    }
  },
  async queue(batch: { messages: { body: QueueTask; attempts: number; retry: (options?: { delaySeconds?: number }) => void; ack: () => void }[] }, env: Env) {
    for (const message of batch.messages) {
      try { await handleTask(env, message.body); message.ack(); }
      catch (error) {
        const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(message.body.jobId).first<Row>();
        if (message.attempts >= 5) {
          const description = safeError(error);
          if (job) {
            await env.DB.prepare(`UPDATE jobs SET status='failed',stage='Needs attention',error=?,updated_at=? WHERE id=?`).bind(description, now(), job.id).run();
            await env.DB.prepare(`UPDATE projects SET status='failed',updated_at=? WHERE id=?`).bind(now(), job.project_id).run();
          }
          if (message.body.kind !== 'story' && message.body.kind !== 'render' && job) await markAssetFailed(env, job, message.body.kind, Number(message.body.ordinal), error);
          message.ack();
        } else message.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.max(0, message.attempts - 1)) });
      }
    }
  },
};