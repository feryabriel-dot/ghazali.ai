export type ProviderConfig = { openAiKey?: string; replicateToken?: string; musicModel?: string };
export type GeneratedMusic = { bytes: ArrayBuffer; contentType: string };

export interface StudioProviders {
  openAi(path: string, payload: unknown): Promise<Response>;
  startMusic(prompt: string, durationSeconds: number, idempotencyKey: string): Promise<string>;
  completeMusic(predictionId: string): Promise<GeneratedMusic>;
}

export function createProviders(config: ProviderConfig): StudioProviders {
  return {
    async openAi(path, payload) {
      if (!config.openAiKey) throw new Error('OpenAI is not configured. Set OPENAI_API_KEY to enable story, image, and speech generation.');
      const response = await fetch(`https://api.openai.com/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${config.openAiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`OpenAI ${path} failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
      return response;
    },
    async startMusic(prompt, durationSeconds, idempotencyKey) {
      if (!config.replicateToken) throw new Error('Original AI music is unavailable: set REPLICATE_API_TOKEN. No placeholder or silent track is used.');
      const model = config.musicModel || 'meta/musicgen';
      const start = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, { method: 'POST', headers: { authorization: `Token ${config.replicateToken}`, 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ input: { prompt, duration: Math.min(30, durationSeconds), output_format: 'mp3' } }), signal: AbortSignal.timeout(30_000) });
      if (!start.ok) throw new Error(`Replicate MusicGen request failed (${start.status}): ${(await start.text()).slice(0, 200)}`);
      const prediction = await start.json() as { id?: string };
      if (!prediction.id) throw new Error('Music provider returned no prediction ID.');
      return prediction.id;
    },
    async completeMusic(predictionId) {
      if (!config.replicateToken) throw new Error('Original AI music is unavailable: set REPLICATE_API_TOKEN. No placeholder or silent track is used.');
      let prediction = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`, { headers: { authorization: `Token ${config.replicateToken}` }, signal: AbortSignal.timeout(20_000) }).then(async (response) => {
        if (!response.ok) throw new Error(`Music generation polling failed (${response.status}).`);
        return await response.json() as { id: string; status: string; urls?: { get?: string }; output?: string | string[]; error?: string };
      });
      const deadline = Date.now() + 150_000;
      while (['starting', 'processing'].includes(prediction.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
        const polled = await fetch(pollUrl, { headers: { authorization: `Token ${config.replicateToken}` }, signal: AbortSignal.timeout(20_000) });
        if (!polled.ok) throw new Error(`Music generation polling failed (${polled.status}).`);
        prediction = await polled.json() as typeof prediction;
      }
      if (prediction.status !== 'succeeded') {
        if (['failed', 'canceled'].includes(prediction.status)) throw new Error(`Music generation ended with status ${prediction.status}: ${prediction.error || 'provider stopped the prediction'}`);
        throw new Error('Music generation did not finish before its processing deadline.');
      }
      const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      if (!outputUrl) throw new Error('Music provider returned no audio file.');
      const audio = await fetch(outputUrl, { signal: AbortSignal.timeout(30_000) });
      if (!audio.ok) throw new Error(`Generated music could not be downloaded (${audio.status}).`);
      const bytes = await audio.arrayBuffer();
      if (bytes.byteLength < 1000) throw new Error('Generated music file is empty or invalid.');
      return { bytes, contentType: audio.headers.get('content-type')?.includes('wav') ? 'audio/wav' : 'audio/mpeg' };
    },
  };
}