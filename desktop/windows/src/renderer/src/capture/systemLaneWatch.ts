// Watches a 'call' session's system lane for the failure that reads as success:
// the loopback is attached and delivering frames, but they are silence while the
// other side of the call is talking (seen 2026-11-12: the sink's monitor source
// sat at 8%, RMS about 1 against about 600 at full volume). Silence alone proves
// nothing, since a quiet lane is normal whenever nothing is playing, so the watch
// asks main whether something is audibly playing (SystemPlaybackProbe, measured on
// the playback streams themselves) once the lane has been silent for a while and
// reports 'silent' only when playback was there on consecutive probes. Any audible
// block reports 'live' again.
//
// Wall-clock based, so a lane that stops delivering frames altogether counts as
// silent too.
import type { SystemPlaybackProbe } from '../../../shared/types'

/** Peak (int16) at or below which a block counts as silence. A monitor source at
 *  8% carries full-scale playback at a peak of about 16; real playback at 100%
 *  peaks in the thousands. */
export const SILENT_PEAK = 64
/** Silence must last this long before the first probe. */
export const SILENT_AFTER_MS = 15_000
/** Probe cadence while the lane stays silent. */
export const PROBE_INTERVAL_MS = 5_000
/** Probes that must find audible playback within one silent stretch before the
 *  lane is called silent, so one sound caught just as it began (before the lane
 *  delivered it) cannot raise the warning. Any audible block starts the count over. */
export const PLAYING_PROBES_TO_WARN = 2

export type SystemLaneWatch = {
  /** Every PCM block the system lane delivers. */
  push: (pcm: Int16Array) => void
  stop: () => void
}

export type SystemLaneWatchOptions = {
  probe: () => Promise<SystemPlaybackProbe>
  /** 'silent' carries a human-readable detail; 'live' clears it. */
  onState: (state: 'silent' | 'live', detail?: string) => void
  now?: () => number
}

/** The largest absolute sample in a block. */
export function peakOf(pcm: Int16Array): number {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (v > peak) peak = v
  }
  return peak
}

/** Why the lane is silent, for the log line and the UI. */
export function silentDetail(
  probe: Extract<SystemPlaybackProbe, { supported: true }>,
  silentMs: number
): string {
  const seconds = Math.round(silentMs / 1000)
  if (probe.monitorMuted) {
    return `The monitor of ${probe.sink} is muted, so call audio is recorded as silence.`
  }
  if (probe.monitorVolumePercent !== null && probe.monitorVolumePercent < 50) {
    return `The monitor of ${probe.sink} is at ${probe.monitorVolumePercent}%, so call audio is recorded as silence.`
  }
  return `No call audio heard for ${seconds} s although audio is playing on ${probe.sink}.`
}

export function createSystemLaneWatch(opts: SystemLaneWatchOptions): SystemLaneWatch {
  const now = opts.now ?? Date.now
  let lastAudibleAt = now()
  let playingProbes = 0
  let warned = false
  let probing = false
  let stopped = false

  const tick = (): void => {
    if (stopped || probing) return
    const silentMs = now() - lastAudibleAt
    if (silentMs < SILENT_AFTER_MS) return
    probing = true
    // The epoch a probe was asked in: audio heard while it was in flight makes
    // its answer stale.
    const askedAt = lastAudibleAt
    opts
      .probe()
      .then((probe) => {
        if (stopped || askedAt !== lastAudibleAt) return
        // A probe that finds nothing playing leaves the count alone: speech has
        // pauses, and playback the lane did not hear stays unheard.
        if (!probe.supported || !probe.playing) return
        playingProbes++
        if (warned || playingProbes < PLAYING_PROBES_TO_WARN) return
        warned = true
        opts.onState('silent', silentDetail(probe, now() - lastAudibleAt))
      })
      .catch(() => {
        /* a failed probe says nothing either way */
      })
      .finally(() => {
        probing = false
      })
  }

  const timer = setInterval(tick, PROBE_INTERVAL_MS)

  return {
    push: (pcm: Int16Array): void => {
      if (stopped || peakOf(pcm) <= SILENT_PEAK) return
      lastAudibleAt = now()
      playingProbes = 0
      if (warned) {
        warned = false
        opts.onState('live')
      }
    },
    stop: (): void => {
      stopped = true
      clearInterval(timer)
    }
  }
}
