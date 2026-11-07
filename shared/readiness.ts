export type ReadinessAsset = { kind: string; ordinal: number; status: string; object_key?: string | null; error?: string | null };
export type ReadinessStory = { scenes: { durationSeconds: number }[] };

export function getReadinessError(story: ReadinessStory, expectedSpeech: number, assets: ReadinessAsset[], requestedDuration: number): string | null {
  if (!story.scenes.length) return 'Story and scene breakdown are missing.';
  if (story.scenes.some((scene) => !Number.isInteger(scene.durationSeconds) || scene.durationSeconds < 3 || scene.durationSeconds > 120)) return 'Render blocked: scene timeline contains invalid durations.';
  const totalDuration = story.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  if (Math.abs(totalDuration - requestedDuration) > Math.max(10, requestedDuration * 0.1)) return 'Render blocked: scene timeline does not match the requested duration.';
  const required = [
    { kind: 'image', count: story.scenes.length },
    { kind: 'speech', count: expectedSpeech },
    { kind: 'music', count: 1 },
  ];
  for (const item of required) {
    const matching = assets.filter((asset) => asset.kind === item.kind);
    if (matching.length !== item.count) return `Render blocked: expected ${item.count} ${item.kind} assets, found ${matching.length}.`;
    for (let ordinal = 0; ordinal < item.count; ordinal += 1) {
      const asset = matching.find((candidate) => candidate.ordinal === ordinal);
      if (!asset || asset.status !== 'ready' || !asset.object_key) {
        return `Render blocked: ${item.kind} ${ordinal + 1} is ${asset?.status || 'missing'}${asset?.error ? `: ${asset.error}` : '.'}`;
      }
    }
  }
  return null;
}