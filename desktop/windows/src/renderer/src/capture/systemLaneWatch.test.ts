import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SystemPlaybackProbe } from '../../../shared/types'
import {
  createSystemLaneWatch,
  peakOf,
  PROBE_INTERVAL_MS,
  SILENT_AFTER_MS,
  SILENT_PEAK,
  silentDetail,
  type SystemLaneWatch
} from './systemLaneWatch'

const SINK = 'bluez_output.test'
type SupportedProbe = Extract<SystemPlaybackProbe, { supported: true }>
const playing = (over: Partial<SupportedProbe> = {}): SupportedProbe => ({
  supported: true,
  playing: true,
  sink: SINK,
  monitorVolumePercent: 100,
  monitorMuted: false,
  ...over
})
const block = (value: number): Int16Array => new Int16Array(1600).fill(value)

let probe: Mock<() => Promise<SystemPlaybackProbe>>
let states: Array<[string, string | undefined]>
let watch: SystemLaneWatch

beforeEach(() => {
  vi.useFakeTimers()
  probe = vi.fn<() => Promise<SystemPlaybackProbe>>().mockResolvedValue(playing())
  states = []
  watch = createSystemLaneWatch({ probe, onState: (state, detail) => states.push([state, detail]) })
})

afterEach(() => {
  watch.stop()
  vi.useRealTimers()
})

/** Let `ms` pass while the lane delivers `value` every 100 ms. */
async function run(ms: number, value: number | null): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    if (value !== null) watch.push(block(value))
    await vi.advanceTimersByTimeAsync(100)
  }
}

describe('system lane watch', () => {
  it('never probes while the lane is audible', async () => {
    await run(60_000, 600)
    expect(probe).not.toHaveBeenCalled()
    expect(states).toEqual([])
  })

  it('reports silent once two probes found playback the lane did not hear', async () => {
    await run(SILENT_AFTER_MS + PROBE_INTERVAL_MS - 100, 0)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(states).toEqual([]) // one probe is not enough
    await run(PROBE_INTERVAL_MS, 0)
    expect(states).toHaveLength(1)
    expect(states[0][0]).toBe('silent')
    expect(states[0][1]).toContain(`audio is playing on ${SINK}`)
  })

  it('reports it once, not on every probe after', async () => {
    await run(SILENT_AFTER_MS + 6 * PROBE_INTERVAL_MS, 0)
    expect(states.map(([state]) => state)).toEqual(['silent'])
  })

  it('treats the level a monitor source at 8% delivers as silence', async () => {
    // Full-scale playback through a monitor at 8% peaks at about 16.
    await run(SILENT_AFTER_MS + 2 * PROBE_INTERVAL_MS, 16)
    expect(states.map(([state]) => state)).toEqual(['silent'])
    expect(16).toBeLessThanOrEqual(SILENT_PEAK)
  })

  it('stays quiet while nothing is playing', async () => {
    probe.mockResolvedValue(playing({ playing: false }))
    await run(SILENT_AFTER_MS + 6 * PROBE_INTERVAL_MS, 0)
    expect(probe.mock.calls.length).toBeGreaterThan(2)
    expect(states).toEqual([])
  })

  it('does not warn for a single sound caught by one probe', async () => {
    probe.mockResolvedValueOnce(playing()).mockResolvedValue(playing({ playing: false }))
    await run(SILENT_AFTER_MS + 6 * PROBE_INTERVAL_MS, 0)
    expect(states).toEqual([])
  })

  it('counts playback across the pauses of speech', async () => {
    // Two probes hear the call, with one landing in a pause between them.
    probe
      .mockResolvedValueOnce(playing())
      .mockResolvedValueOnce(playing({ playing: false }))
      .mockResolvedValue(playing())
    await run(SILENT_AFTER_MS + 2 * PROBE_INTERVAL_MS, 0)
    expect(states.map(([state]) => state)).toEqual(['silent'])
  })

  it('starts the count over once the lane hears something', async () => {
    probe.mockResolvedValueOnce(playing()).mockResolvedValue(playing({ playing: false }))
    await run(SILENT_AFTER_MS + PROBE_INTERVAL_MS - 100, 0) // one probe found playback
    watch.push(block(900)) // and the lane did hear it
    probe
      .mockReset()
      .mockResolvedValueOnce(playing())
      .mockResolvedValue(playing({ playing: false }))
    await run(SILENT_AFTER_MS + 4 * PROBE_INTERVAL_MS, 0)
    expect(states).toEqual([])
  })

  it('never warns where playback cannot be probed', async () => {
    probe.mockResolvedValue({ supported: false })
    await run(SILENT_AFTER_MS + 6 * PROBE_INTERVAL_MS, 0)
    expect(states).toEqual([])
  })

  it('survives a probe that fails', async () => {
    probe.mockRejectedValueOnce(new Error('ipc gone')).mockResolvedValue(playing())
    await run(SILENT_AFTER_MS + 3 * PROBE_INTERVAL_MS, 0)
    expect(states.map(([state]) => state)).toEqual(['silent'])
  })

  it('reports live again at the first audible block, and can warn again later', async () => {
    await run(SILENT_AFTER_MS + 2 * PROBE_INTERVAL_MS, 0)
    watch.push(block(900))
    expect(states.map(([state]) => state)).toEqual(['silent', 'live'])
    await run(SILENT_AFTER_MS + 2 * PROBE_INTERVAL_MS, 0)
    expect(states.map(([state]) => state)).toEqual(['silent', 'live', 'silent'])
  })

  it('counts a lane that stops delivering frames as silent', async () => {
    await run(SILENT_AFTER_MS + 2 * PROBE_INTERVAL_MS, null)
    expect(states.map(([state]) => state)).toEqual(['silent'])
  })

  it('drops the answer of a probe that audio overtook', async () => {
    let answer!: (p: SystemPlaybackProbe) => void
    probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await run(SILENT_AFTER_MS + PROBE_INTERVAL_MS, 0)
    expect(probe).toHaveBeenCalledTimes(1)
    watch.push(block(900)) // heard while the probe was in flight
    answer(playing())
    probe.mockResolvedValue(playing())
    // One more probe after the next silent stretch is still only the first of two.
    await run(SILENT_AFTER_MS + PROBE_INTERVAL_MS - 100, 0)
    expect(states).toEqual([])
  })

  it('stops probing and reporting once stopped', async () => {
    await run(SILENT_AFTER_MS + PROBE_INTERVAL_MS - 100, 0)
    watch.stop()
    await run(4 * PROBE_INTERVAL_MS, 0)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(states).toEqual([])
  })
})

describe('silentDetail', () => {
  it('names a low monitor volume as the cause', () => {
    expect(silentDetail(playing({ monitorVolumePercent: 8 }), 20_000)).toBe(
      `The monitor of ${SINK} is at 8%, so call audio is recorded as silence.`
    )
  })

  it('names a muted monitor as the cause', () => {
    expect(silentDetail(playing({ monitorMuted: true }), 20_000)).toBe(
      `The monitor of ${SINK} is muted, so call audio is recorded as silence.`
    )
  })

  it('falls back to how long nothing was heard', () => {
    expect(silentDetail(playing({ monitorVolumePercent: null }), 24_600)).toBe(
      `No call audio heard for 25 s although audio is playing on ${SINK}.`
    )
  })
})

describe('peakOf', () => {
  it('is the largest absolute sample', () => {
    expect(peakOf(new Int16Array([3, -40, 12]))).toBe(40)
    expect(peakOf(new Int16Array([-32768]))).toBe(32768)
    expect(peakOf(new Int16Array(0))).toBe(0)
  })
})
