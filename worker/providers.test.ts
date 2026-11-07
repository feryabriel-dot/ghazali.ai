import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviders } from './providers';

afterEach(() => vi.unstubAllGlobals());

describe('provider adapters', () => {
  it('does not make a provider request when credentials are absent', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const providers = createProviders({});
    await expect(providers.openAi('chat/completions', {})).rejects.toThrow('OPENAI_API_KEY');
    await expect(providers.startMusic('instrumental', 60, 'job:music:0')).rejects.toThrow('REPLICATE_API_TOKEN');
    await expect(providers.completeMusic('prediction-id')).rejects.toThrow('REPLICATE_API_TOKEN');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps API credentials in server-side request headers and reports provider errors', async () => {
    const request = vi.fn().mockResolvedValue(new Response('quota exhausted', { status: 429 }));
    vi.stubGlobal('fetch', request);
    const providers = createProviders({ openAiKey: 'test-secret' });
    await expect(providers.openAi('audio/speech', { input: 'test' })).rejects.toThrow('failed (429): quota exhausted');
    expect(request.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/speech');
    expect(request.mock.calls[0][1].headers.authorization).toBe('Bearer test-secret');
  });
});