// Chromium features the app switches off on Linux (applied in index.ts before the
// app is ready, which is the only point where they take effect).

/**
 * WebRtcAllowInputVolumeAdjustment: with it on (Chromium's default), the gain
 * control of every processed capture stream may write the volume of the device it
 * records. On Linux that is the PulseAudio/PipeWire source volume, which is
 * shared with every other application and outlives the app:
 *  - on the system-audio loopback it set the default sink's monitor source to 8%,
 *    so the other side of a call was recorded as silence (2026-11-12; the loopback
 *    is also requested unprocessed now, see lib/capture/systemAudio.ts);
 *  - on the mic it turns the system microphone level up and down under whatever
 *    call application is using the same microphone.
 * A recorder should listen, not adjust. With the feature off the mic lanes keep
 * echo cancellation, noise suppression and WebRTC's digital gain control (which
 * scales the samples, not the device), so transcription levels are unchanged.
 */
export const LINUX_DISABLED_FEATURES: readonly string[] = ['WebRtcAllowInputVolumeAdjustment']

/** Add feature names to a comma-separated --enable-features/--disable-features
 *  value, keeping what a launcher already passed and skipping duplicates. */
export function mergeFeatureList(existing: string, add: readonly string[]): string {
  const names = existing
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  for (const name of add) {
    if (!names.includes(name)) names.push(name)
  }
  return names.join(',')
}
