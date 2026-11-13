import { ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import type { CaptureEvent, SystemPlaybackProbe } from '../../shared/types'
import { isCallSystemLaneWarning } from '../../shared/types'
import { onCaptureEventInMain } from '../ipc/captureBridge'

// Whether something is audibly playing to the default output, for a 'call'
// session whose system lane has gone silent (renderer: capture/systemLaneWatch.ts).
// A silent loopback is normal while nothing plays and a fault while something
// does, and only the sound server can tell the two apart.
//
// Linux only, through the PulseAudio tools (PulseAudio 16+, or pipewire-pulse):
//   pactl info          → the default sink's name
//   pactl sinks         → its index and its monitor source
//   pactl sink-inputs   → the playback streams on that sink
//   pactl sources       → the monitor's volume and mute, since the loopback
//                         records the monitor and a low volume there is the
//                         silence (2026-11-12: 8%)
//   parec --monitor-stream=<sink-input> → the level of each playback stream
//
// Neither the sink's state nor an open stream means sound: a capture stream on the
// monitor (ours) keeps the sink RUNNING, and applications, this one included, keep
// uncorked streams open that carry silence. So each playback stream is tapped for
// a moment and only a peak above AUDIBLE_PEAK counts as playing. The tap reads the
// stream itself, after its own volume and before the sink's monitor, so it still
// hears playback that the monitor's volume has silenced (measured: peak 4804 on
// the tap against 2 on a monitor at 8%).
//
// Any failure (tools missing, an older pactl without JSON, a parse error, no tap
// that worked) answers `supported: false`, which never raises a warning.

/** Peak (int16) from which a playback stream counts as audible. Well above the
 *  level the system lane must stay under to count as silent (SILENT_PEAK), so a
 *  stream that is merely very quiet never reads as "playing but not heard". */
export const AUDIBLE_PEAK = 512
/** How long each playback stream is tapped. */
const TAP_MS = 350
/** Streams tapped per probe; more than this never play at once in practice. */
const MAX_TAPS = 6

type PactlVolume = Record<string, { value_percent?: string }>
type PactlSink = { index: number; name: string; monitor_source?: string }
type PactlSinkInput = { index: number; sink: number; corked: boolean; mute?: boolean }
type PactlSource = { name: string; mute?: boolean; volume?: PactlVolume }

export type PactlSnapshot = {
  info: unknown
  sinks: unknown
  sinkInputs: unknown
  sources: unknown
}

/** The default sink, the playback streams on it that could be audible (uncorked,
 *  not muted), and its monitor source's volume. */
export type PlaybackCandidates = {
  sink: string
  streams: number[]
  monitorVolumePercent: number | null
  monitorMuted: boolean
}

/** The loudest channel of a pactl volume object in percent, or null. */
export function maxVolumePercent(volume: PactlVolume | undefined): number | null {
  if (!volume) return null
  let max: number | null = null
  for (const channel of Object.values(volume)) {
    const m = /^(\d+)%$/.exec(channel?.value_percent ?? '')
    if (!m) continue
    const percent = Number(m[1])
    if (max === null || percent > max) max = percent
  }
  return max
}

/** Fold the four pactl listings into the streams worth tapping. Pure, so it is
 *  tested on recorded output; null for anything unexpected. */
export function resolvePlaybackCandidates(snapshot: PactlSnapshot): PlaybackCandidates | null {
  const sinkName = (snapshot.info as { default_sink_name?: unknown } | null)?.default_sink_name
  if (typeof sinkName !== 'string' || sinkName === '') return null
  if (
    !Array.isArray(snapshot.sinks) ||
    !Array.isArray(snapshot.sinkInputs) ||
    !Array.isArray(snapshot.sources)
  ) {
    return null
  }
  const sink = (snapshot.sinks as PactlSink[]).find((s) => s?.name === sinkName)
  if (!sink || typeof sink.index !== 'number') return null
  const streams = (snapshot.sinkInputs as PactlSinkInput[])
    .filter(
      (input) =>
        input?.sink === sink.index &&
        input.corked === false &&
        input.mute !== true &&
        typeof input.index === 'number'
    )
    .map((input) => input.index)
  const monitorName = sink.monitor_source ?? `${sinkName}.monitor`
  const monitor = (snapshot.sources as PactlSource[]).find((s) => s?.name === monitorName)
  return {
    sink: sinkName,
    streams,
    monitorVolumePercent: maxVolumePercent(monitor?.volume),
    monitorMuted: monitor?.mute === true
  }
}

/** The probe for a set of candidates and the peak each was tapped at (null where
 *  the tap failed). With streams to judge and no tap that worked there is no
 *  telling, which is `supported: false` rather than "nothing is playing". */
export function playbackProbeFromPeaks(
  candidates: PlaybackCandidates,
  peaks: Array<number | null>
): SystemPlaybackProbe {
  const measured = peaks.filter((peak): peak is number => peak !== null)
  if (candidates.streams.length > 0 && measured.length === 0) return { supported: false }
  return {
    supported: true,
    playing: measured.some((peak) => peak >= AUDIBLE_PEAK),
    sink: candidates.sink,
    monitorVolumePercent: candidates.monitorVolumePercent,
    monitorMuted: candidates.monitorMuted
  }
}

/** The largest absolute sample of little-endian 16-bit PCM. */
export function peakOfPcm16(pcm: Buffer): number {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i))
    if (v > peak) peak = v
  }
  return peak
}

const TOOL_ENV = { ...process.env, LC_ALL: 'C' }

function pactlJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'pactl',
      ['--format=json', ...args],
      { timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: TOOL_ENV },
      (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

/** Record one playback stream for TAP_MS and return its peak, or null when the
 *  tap could not run (no parec, the stream ended first). */
function tapSinkInputPeak(sinkInput: number): Promise<number | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (peak: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(peak)
    }
    const child = spawn(
      'parec',
      [
        `--monitor-stream=${sinkInput}`,
        '--raw',
        '--format=s16le',
        '--rate=16000',
        '--channels=1',
        '--latency-msec=40'
      ],
      { env: TOOL_ENV, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const timer = setTimeout(() => child.kill('SIGTERM'), TAP_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => finish(null))
    child.on('close', () => finish(chunks.length > 0 ? peakOfPcm16(Buffer.concat(chunks)) : null))
  })
}

export async function probeSystemPlayback(
  platform: NodeJS.Platform = process.platform,
  run: (args: string[]) => Promise<unknown> = pactlJson,
  tap: (sinkInput: number) => Promise<number | null> = tapSinkInputPeak
): Promise<SystemPlaybackProbe> {
  if (platform !== 'linux') return { supported: false }
  try {
    const [info, sinks, sinkInputs, sources] = await Promise.all([
      run(['info']),
      run(['list', 'sinks']),
      run(['list', 'sink-inputs']),
      run(['list', 'sources'])
    ])
    const candidates = resolvePlaybackCandidates({ info, sinks, sinkInputs, sources })
    if (!candidates) return { supported: false }
    const peaks = await Promise.all(candidates.streams.slice(0, MAX_TAPS).map((s) => tap(s)))
    return playbackProbeFromPeaks(candidates, peaks)
  } catch {
    return { supported: false }
  }
}

/** The main.log line for a call session's system-lane change: a warning for the
 *  states that mean the other side is not being recorded, else a plain log. */
export function callAudioLogLine(event: Extract<CaptureEvent, { type: 'call-audio-status' }>): {
  level: 'warn' | 'log'
  text: string
} {
  const text = `[call-capture] system lane ${event.system} ${event.sessionId}${
    event.detail ? `: ${event.detail}` : ''
  }`
  return { level: isCallSystemLaneWarning(event.system) ? 'warn' : 'log', text }
}

export function registerSystemPlaybackHandlers(): void {
  ipcMain.handle('omi-capture:systemPlaybackProbe', () => probeSystemPlayback())
  // The capture window's console never reaches main.log, and a session that
  // records only the mic otherwise leaves no trace there.
  onCaptureEventInMain((event) => {
    if (event.type !== 'call-audio-status') return
    const line = callAudioLogLine(event)
    if (line.level === 'warn') console.warn(line.text)
    else console.log(line.text)
  })
}
