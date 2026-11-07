import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { createMediaStore, mediaResponse, type MediaBucket, type MediaObject } from './storage';

const fixtureBytes = Uint8Array.from({ length: 2048 }, (_, index) => index % 251);

function stream(bytes: Uint8Array) {
  return new Response(bytes).body!;
}

class FixtureBucket implements MediaBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  put = vi.fn(async (key: string, value: ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType || 'application/octet-stream' });
  });
  get = vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }): Promise<MediaObject | null> => {
    const item = this.objects.get(key);
    if (!item) return null;
    const bytes = options?.range
      ? item.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : item.bytes;
    return { body: stream(bytes), size: item.bytes.byteLength, httpMetadata: { contentType: item.contentType } };
  });
  head = vi.fn(async (key: string) => {
    const item = this.objects.get(key);
    return item ? { size: item.bytes.byteLength } : null;
  });
  delete = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  });
}

function databaseFixture(project: Record<string, unknown>, asset: Record<string, unknown>, keys = [String(asset.object_key)]) {
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      statements.push(sql);
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first<T>() {
          if (sql.includes('FROM projects WHERE id=? AND owner=?')) return project as T;
          if (sql.includes('FROM assets a JOIN jobs j') || sql.includes('FROM assets a JOIN projects p')) return asset as T;
          return null;
        },
        async all<T>() {
          if (sql.includes('SELECT object_key FROM assets')) return { results: keys.map((object_key) => ({ object_key })) as T[] };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: values.length ? 1 : 0 } }; },
      };
    },
    batch: async () => [],
  };
  return { database, statements };
}

function environment(bucket: FixtureBucket, database: ReturnType<typeof databaseFixture>['database'], extra: Record<string, unknown> = {}) {
  return {
    MEDIA: bucket,
    DB: database,
    PRODUCTION_QUEUE: { send: async () => {} },
    STATIC: { fetch: async () => new Response('static') },
    APP_ORIGIN: 'http://127.0.0.1:5173',
    DEV_AUTH_BYPASS: 'true',
    ...extra,
  } as never;
}

describe('persistent media storage', () => {
  it('uploads with content metadata, retrieves, checks existence, and deletes media', async () => {
    const bucket = new FixtureBucket();
    const storage = createMediaStore(bucket);
    await storage.put('project/job/image/0', fixtureBytes.buffer, 'image/png');
    expect(bucket.put).toHaveBeenCalledWith('project/job/image/0', fixtureBytes.buffer, { httpMetadata: { contentType: 'image/png' } });
    expect(await storage.head('project/job/image/0')).toEqual({ size: fixtureBytes.byteLength });
    const retrieved = await storage.get('project/job/image/0');
    expect(retrieved?.httpMetadata?.contentType).toBe('image/png');
    expect([...new Uint8Array(await new Response(retrieved!.body).arrayBuffer())]).toEqual([...fixtureBytes]);
    await storage.delete(['project/job/image/0']);
    expect(await storage.head('project/job/image/0')).toBeNull();
  });

  it('serves byte ranges and rejects invalid ranges without exposing media', async () => {
    const bucket = new FixtureBucket();
    const storage = createMediaStore(bucket);
    await storage.put('project/final.mp4', fixtureBytes.buffer, 'video/mp4');
    const response = await mediaResponse(storage, 'project/final.mp4', {
      contentType: 'video/mp4', disposition: 'inline', rangeHeader: 'bytes=10-19',
    });
    expect(response?.status).toBe(206);
    expect(response?.headers.get('content-range')).toBe(`bytes 10-19/${fixtureBytes.byteLength}`);
    expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([...fixtureBytes.slice(10, 20)]);
    const invalid = await mediaResponse(storage, 'project/final.mp4', {
      contentType: 'video/mp4', disposition: 'inline', rangeHeader: 'bytes=9999-',
    });
    expect(invalid?.status).toBe(416);
    expect(await invalid?.text()).toBe('');
  });

  it('allows the renderer to fetch only a valid HMAC-signed private media URL', async () => {
    const bucket = new FixtureBucket();
    const storage = createMediaStore(bucket);
    await storage.put('private/project/image.png', fixtureBytes.buffer, 'image/png');
    const secret = 'dedicated-media-signing-secret-for-tests';
    const expires = Math.floor(Date.now() / 1000) + 60;
    const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`private/project/image.png\n${expires}`)));
    const signature = btoa(String.fromCharCode(...signatureBytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const env = environment(bucket, databaseFixture({}, {}).database, { MEDIA_SIGNING_SECRET: secret, RENDERER_TOKEN: 'separate-renderer-request-secret' });
    const signed = await worker.fetch(new Request(`http://127.0.0.1/api/media/${encodeURIComponent('private/project/image.png')}?expires=${expires}&signature=${signature}`), env);
    expect(signed.status).toBe(200);
    expect(signed.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await signed.arrayBuffer())]).toEqual([...fixtureBytes]);
    const unsigned = await worker.fetch(new Request(`http://127.0.0.1/api/media/${encodeURIComponent('private/project/image.png')}`), env);
    expect(unsigned.status).toBe(403);
    const write = await worker.fetch(new Request(`http://127.0.0.1/api/media/${encodeURIComponent('private/project/image.png')}?expires=${expires}&signature=${signature}`, { method: 'POST' }), env);
    expect(write.status).toBe(405);
  });

  it('serves the completed project MP4 as an authenticated, range-capable download', async () => {
    const bucket = new FixtureBucket();
    await createMediaStore(bucket).put('project/job/video/final.mp4', fixtureBytes.buffer, 'video/mp4');
    const project = { id: 'project', owner: 'local-development', title: 'Test Drama' };
    const asset = { object_key: 'project/job/video/final.mp4' };
    const env = environment(bucket, databaseFixture(project, asset).database);
    const response = await worker.fetch(new Request('http://127.0.0.1/api/projects/project/download', { headers: { Range: 'bytes=0-7' } }), env);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('Test_Drama.mp4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtureBytes.slice(0, 8));
  });

  it('serves authenticated previews and project assets from persistent storage', async () => {
    const bucket = new FixtureBucket();
    const storage = createMediaStore(bucket);
    await storage.put('project/job/video/final.mp4', fixtureBytes.buffer, 'video/mp4');
    await storage.put('project/job/image/0', fixtureBytes.buffer, 'image/png');
    const project = { id: 'project', owner: 'local-development' };
    const previewEnv = environment(bucket, databaseFixture(project, { object_key: 'project/job/video/final.mp4' }).database);
    const preview = await worker.fetch(new Request('http://127.0.0.1/api/projects/project/preview'), previewEnv);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(fixtureBytes);

    const assetEnv = environment(bucket, databaseFixture({}, { object_key: 'project/job/image/0', content_type: 'image/png' }).database);
    const asset = await worker.fetch(new Request('http://127.0.0.1/api/assets/image-id?download=1'), assetEnv);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(asset.headers.get('content-disposition')).toBe('attachment');
  });

  it('removes project media before deleting its project record', async () => {
    const bucket = new FixtureBucket();
    const keys = ['project/job/image/0', 'project/job/video/final.mp4'];
    for (const key of keys) await createMediaStore(bucket).put(key, fixtureBytes.buffer, 'application/octet-stream');
    const fixture = databaseFixture({ id: 'project', owner: 'local-development' }, {}, keys);
    const response = await worker.fetch(new Request('http://127.0.0.1/api/projects/project', {
      method: 'DELETE', headers: { Origin: 'http://127.0.0.1:5173' },
    }), environment(bucket, fixture.database));
    expect(response.status).toBe(200);
    expect(bucket.delete).toHaveBeenCalledWith(keys);
    expect(keys.every((key) => !bucket.objects.has(key))).toBe(true);
    expect(fixture.statements.at(-1)).toContain('DELETE FROM projects');
  });
});
