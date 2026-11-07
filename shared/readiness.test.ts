import { describe, expect, it } from 'vitest';
import { getReadinessError, type ReadinessAsset } from './readiness';

const story = { scenes: [{ durationSeconds: 30 }, { durationSeconds: 30 }] };
const complete: ReadinessAsset[] = [
  { kind: 'image', ordinal: 0, status: 'ready', object_key: 'image/0' },
  { kind: 'image', ordinal: 1, status: 'ready', object_key: 'image/1' },
  { kind: 'speech', ordinal: 0, status: 'ready', object_key: 'speech/0' },
  { kind: 'music', ordinal: 0, status: 'ready', object_key: 'music/0' },
];

describe('render-readiness gate', () => {
  it('passes only when every required indexed asset and the timeline are valid', () => {
    expect(getReadinessError(story, 1, complete, 60)).toBeNull();
  });

  it('identifies a missing image, invalid audio, or missing music', () => {
    expect(getReadinessError(story, 1, complete.map((asset) => asset.kind === 'image' && asset.ordinal === 1 ? { ...asset, status: 'pending' } : asset), 60)).toMatch(/image 2 is pending/);
    expect(getReadinessError(story, 1, complete.map((asset) => asset.kind === 'speech' ? { ...asset, status: 'failed', error: 'provider error' } : asset), 60)).toMatch(/speech 1 is failed: provider error/);
    expect(getReadinessError(story, 1, complete.filter((asset) => asset.kind !== 'music'), 60)).toMatch(/music assets, found 0/);
  });

  it('rejects invalid scene timing', () => {
    expect(getReadinessError({ scenes: [{ durationSeconds: 3 }] }, 1, complete, 60)).toMatch(/timeline does not match/);
  });
});