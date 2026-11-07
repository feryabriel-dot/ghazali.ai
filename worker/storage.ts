export type MediaRange = { offset: number; length: number };
export type MediaObject = {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
  size: number;
};

export type MediaBucket = {
  put: (key: string, value: ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  get: (key: string, options?: { range?: MediaRange }) => Promise<MediaObject | null>;
  head: (key: string) => Promise<{ size: number } | null>;
  delete: (keys: string | string[]) => Promise<void>;
};

export type MediaStore = {
  put: (key: string, value: ArrayBuffer | ReadableStream, contentType: string) => Promise<void>;
  get: (key: string, range?: MediaRange) => Promise<MediaObject | null>;
  head: (key: string) => Promise<{ size: number } | null>;
  delete: (keys: string[]) => Promise<void>;
};

export function createMediaStore(bucket: MediaBucket): MediaStore {
  return {
    async put(key, value, contentType) {
      await bucket.put(key, value, { httpMetadata: { contentType } });
    },
    get(key, range) {
      return bucket.get(key, range ? { range } : undefined);
    },
    head(key) {
      return bucket.head(key);
    },
    delete(keys) {
      return bucket.delete(keys);
    },
  };
}

function parseRange(value: string, size: number): MediaRange | null | false {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset >= size || requestedEnd < offset) return false;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

export async function mediaResponse(
  store: MediaStore,
  key: string,
  options: { contentType?: string; disposition: string; cacheControl?: string; rangeHeader?: string },
): Promise<Response | null> {
  const head = options.rangeHeader ? await store.head(key) : null;
  const range = options.rangeHeader ? parseRange(options.rangeHeader, head?.size ?? 0) : null;
  if (range === false) {
    const size = head?.size ?? 0;
    if (!size) return null;
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' } });
  }
  const object = await store.get(key, range || undefined);
  if (!object) return null;
  const size = range ? head?.size : object.size;
  if (size === undefined || size === null) return null;
  const headers = new Headers({
    'content-type': options.contentType || object.httpMetadata?.contentType || 'application/octet-stream',
    'content-length': String(range ? range.length : object.size),
    'content-disposition': options.disposition,
    'cache-control': options.cacheControl || 'private, no-store',
    'accept-ranges': 'bytes',
  });
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
