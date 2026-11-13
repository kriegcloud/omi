import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The default tap spawns `parec`. Mocked so its arguments are pinned without a
// sound server (CI has none).
const spawnMock = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn()
}))
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn()
}))

import {
  AUDIBLE_PEAK,
  callAudioLogLine,
  maxVolumePercent,
  peakOfPcm16,
  playbackProbeFromPeaks,
  probeSystemPlayback,
  resolvePlaybackCandidates,
  type PactlSnapshot,
  type PlaybackCandidates
} from './systemPlayback'

// Shapes as `pactl --format=json` prints them on pipewire-pulse (PipeWire 1.6,
// pactl 17), cut down to the fields the probe reads.
const SINK = 'bluez_output.00_11_22_33_44_55.1'
const volume = (percent: number): Record<string, { value: number; value_percent: string }> => ({
  'front-left': { value: Math.round((percent / 100) * 65536), value_percent: `${percent}%` },
  'front-right': { value: Math.round((percent / 100) * 65536), value_percent: `${percent}%` }
})

function snapshot(over: Partial<PactlSnapshot> = {}): PactlSnapshot {
  return {
    info: { server_name: 'PulseAudio (on PipeWire 1.6.11)', default_sink_name: SINK },
    sinks: [
      { index: 73, name: 'alsa_output.hdmi-stereo', state: 'SUSPENDED' },
      // RUNNING says nothing: our own capture on the monitor keeps it running.
      { index: 814, name: SINK, state: 'RUNNING', monitor_source: `${SINK}.monitor` }
    ],
    sinkInputs: [{ index: 2309, sink: 814, corked: false, mute: false }],
    sources: [
      { name: 'alsa_output.hdmi-stereo.monitor', mute: false, volume: volume(100) },
      { name: `${SINK}.monitor`, mute: false, volume: volume(100) }
    ],
    ...over
  }
}

const candidates = (over: Partial<PlaybackCandidates> = {}): PlaybackCandidates => ({
  sink: SINK,
  streams: [2309],
  monitorVolumePercent: 100,
  monitorMuted: false,
  ...over
})

describe('resolvePlaybackCandidates', () => {
  it('lists the uncorked streams on the default sink with the monitor volume', () => {
    expect(resolvePlaybackCandidates(snapshot())).toEqual(candidates())
  })

  it('reads the monitor volume that silences the loopback', () => {
    const found = resolvePlaybackCandidates(
      snapshot({ sources: [{ name: `${SINK}.monitor`, mute: false, volume: volume(8) }] })
    )
    expect(found).toMatchObject({ monitorVolumePercent: 8, monitorMuted: false })
  })

  it('reads a muted monitor', () => {
    const found = resolvePlaybackCandidates(
      snapshot({ sources: [{ name: `${SINK}.monitor`, mute: true, volume: volume(100) }] })
    )
    expect(found).toMatchObject({ monitorMuted: true })
  })

  it('leaves out corked and muted streams and streams on another sink', () => {
    const found = resolvePlaybackCandidates(
      snapshot({
        sinkInputs: [
          { index: 1, sink: 814, corked: true, mute: false },
          { index: 2, sink: 814, corked: false, mute: true },
          { index: 3, sink: 73, corked: false, mute: false },
          { index: 4, sink: 814, corked: false, mute: false }
        ]
      })
    )
    expect(found?.streams).toEqual([4])
  })

  it('reports an unreadable monitor volume as unknown, not as zero', () => {
    const found = resolvePlaybackCandidates(snapshot({ sources: [] }))
    expect(found).toMatchObject({ monitorVolumePercent: null, monitorMuted: false })
  })

  it('is null when the listings are not what pactl prints', () => {
    expect(resolvePlaybackCandidates(snapshot({ info: {} }))).toBeNull()
    expect(resolvePlaybackCandidates(snapshot({ info: null }))).toBeNull()
    expect(resolvePlaybackCandidates(snapshot({ sinks: [] }))).toBeNull()
    expect(resolvePlaybackCandidates(snapshot({ sinkInputs: 'nope' }))).toBeNull()
  })
})

describe('playbackProbeFromPeaks', () => {
  it('is playing when a stream is audible', () => {
    expect(playbackProbeFromPeaks(candidates({ streams: [1, 2] }), [0, 6613])).toEqual({
      supported: true,
      playing: true,
      sink: SINK,
      monitorVolumePercent: 100,
      monitorMuted: false
    })
  })

  it('is not playing when every open stream carries silence', () => {
    // Applications keep uncorked streams open that play nothing (measured: peak 0).
    expect(playbackProbeFromPeaks(candidates(), [0])).toMatchObject({ playing: false })
    expect(playbackProbeFromPeaks(candidates(), [AUDIBLE_PEAK - 1])).toMatchObject({
      playing: false
    })
  })

  it('is not playing with no streams at all', () => {
    expect(playbackProbeFromPeaks(candidates({ streams: [] }), [])).toMatchObject({
      supported: true,
      playing: false
    })
  })

  it('keeps the monitor volume beside the verdict', () => {
    expect(playbackProbeFromPeaks(candidates({ monitorVolumePercent: 8 }), [4804])).toMatchObject({
      playing: true,
      monitorVolumePercent: 8
    })
  })

  it('is unsupported when no stream could be tapped', () => {
    expect(playbackProbeFromPeaks(candidates({ streams: [1, 2] }), [null, null])).toEqual({
      supported: false
    })
  })

  it('judges by the taps that worked', () => {
    expect(playbackProbeFromPeaks(candidates({ streams: [1, 2] }), [null, 900])).toMatchObject({
      supported: true,
      playing: true
    })
  })
})

describe('peakOfPcm16', () => {
  it('is the largest absolute little-endian sample', () => {
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(120, 0)
    pcm.writeInt16LE(-4804, 2)
    pcm.writeInt16LE(33, 4)
    pcm.writeInt16LE(-32768, 6)
    expect(peakOfPcm16(pcm.subarray(0, 6))).toBe(4804)
    expect(peakOfPcm16(pcm)).toBe(32768)
  })

  it('ignores a trailing odd byte and an empty buffer', () => {
    expect(peakOfPcm16(Buffer.from([0x10, 0x00, 0x7f]))).toBe(16)
    expect(peakOfPcm16(Buffer.alloc(0))).toBe(0)
  })
})

describe('maxVolumePercent', () => {
  it('takes the loudest channel', () => {
    expect(
      maxVolumePercent({
        'front-left': { value_percent: '8%' },
        'front-right': { value_percent: '40%' }
      })
    ).toBe(40)
  })

  it('is null without a readable channel', () => {
    expect(maxVolumePercent(undefined)).toBeNull()
    expect(maxVolumePercent({ mono: {} })).toBeNull()
  })
})

describe('probeSystemPlayback', () => {
  const pactl = (s: PactlSnapshot) =>
    vi.fn(async (args: string[]) => {
      const key = args.join(' ')
      if (key === 'info') return s.info
      if (key === 'list sinks') return s.sinks
      if (key === 'list sink-inputs') return s.sinkInputs
      if (key === 'list sources') return s.sources
      throw new Error(`unexpected pactl ${key}`)
    })

  it('taps each candidate stream and reports audible playback', async () => {
    const run = pactl(
      snapshot({
        sinkInputs: [
          { index: 2309, sink: 814, corked: false, mute: false },
          { index: 40012, sink: 814, corked: false, mute: false }
        ]
      })
    )
    const tap = vi.fn(async (stream: number) => (stream === 40012 ? 6613 : 0))
    expect(await probeSystemPlayback('linux', run, tap)).toMatchObject({
      supported: true,
      playing: true
    })
    expect(run).toHaveBeenCalledTimes(4)
    expect(tap.mock.calls.map(([stream]) => stream)).toEqual([2309, 40012])
  })

  it('does not call an idle application stream playback', async () => {
    const tap = vi.fn(async () => 0)
    expect(await probeSystemPlayback('linux', pactl(snapshot()), tap)).toMatchObject({
      supported: true,
      playing: false
    })
  })

  it('is unsupported when pactl is missing or fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn pactl ENOENT')
    })
    const tap = vi.fn()
    expect(await probeSystemPlayback('linux', run, tap)).toEqual({ supported: false })
    expect(tap).not.toHaveBeenCalled()
  })

  it('is unsupported when parec is missing', async () => {
    const tap = vi.fn(async () => null)
    expect(await probeSystemPlayback('linux', pactl(snapshot()), tap)).toEqual({
      supported: false
    })
  })

  it('does not run the tools on other platforms', async () => {
    const run = vi.fn()
    const tap = vi.fn()
    expect(await probeSystemPlayback('win32', run, tap)).toEqual({ supported: false })
    expect(run).not.toHaveBeenCalled()
    expect(tap).not.toHaveBeenCalled()
  })
})

describe('the default parec tap', () => {
  type FakeChild = EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }
  const pactl = (s: PactlSnapshot) => async (args: string[]) => {
    const key = args.join(' ')
    if (key === 'info') return s.info
    if (key === 'list sinks') return s.sinks
    if (key === 'list sink-inputs') return s.sinkInputs
    return s.sources
  }
  /** A parec that prints `pcm` and exits, as it does when the tap window ends. */
  function fakeParec(pcm: Buffer | null): FakeChild {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      kill: vi.fn()
    }) as FakeChild
    queueMicrotask(() => {
      if (pcm) child.stdout.emit('data', pcm)
      child.emit('close', 0)
    })
    return child
  }
  const loud = (): Buffer => {
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(6613, 0)
    pcm.writeInt16LE(-20, 2)
    return pcm
  }

  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('records the reported sink input as 16 kHz mono s16le', async () => {
    spawnMock.mockImplementation(() => fakeParec(loud()))
    const probe = await probeSystemPlayback('linux', pactl(snapshot()))
    expect(probe).toMatchObject({ supported: true, playing: true })
    expect(spawnMock).toHaveBeenCalledOnce()
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(command).toBe('parec')
    expect(args).toEqual(
      expect.arrayContaining([
        '--monitor-stream=2309', // the sink input pactl listed
        '--raw',
        '--format=s16le',
        '--rate=16000',
        '--channels=1'
      ])
    )
  })

  it('taps every candidate stream by its own index', async () => {
    spawnMock.mockImplementation(() => fakeParec(Buffer.alloc(4)))
    const probe = await probeSystemPlayback(
      'linux',
      pactl(
        snapshot({
          sinkInputs: [
            { index: 11, sink: 814, corked: false, mute: false },
            { index: 12, sink: 814, corked: false, mute: false }
          ]
        })
      )
    )
    expect(probe).toMatchObject({ supported: true, playing: false })
    const streams = spawnMock.mock.calls.map(([, args]) => (args as string[])[0])
    expect(streams).toEqual(['--monitor-stream=11', '--monitor-stream=12'])
  })

  it('is unsupported when parec cannot be started', async () => {
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        kill: vi.fn()
      }) as FakeChild
      queueMicrotask(() => child.emit('error', new Error('spawn parec ENOENT')))
      return child
    })
    expect(await probeSystemPlayback('linux', pactl(snapshot()))).toEqual({ supported: false })
  })

  it('is unsupported when parec prints nothing', async () => {
    spawnMock.mockImplementation(() => fakeParec(null))
    expect(await probeSystemPlayback('linux', pactl(snapshot()))).toEqual({ supported: false })
  })

  it('is unsupported when spawn itself throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOTDIR')
    })
    expect(await probeSystemPlayback('linux', pactl(snapshot()))).toEqual({ supported: false })
  })
})

describe('callAudioLogLine', () => {
  it('warns for the states that lose the other side of the call', () => {
    expect(
      callAudioLogLine({
        type: 'call-audio-status',
        sessionId: 'omi-listen-1',
        system: 'silent',
        detail: 'The monitor of sink is at 8%, so call audio is recorded as silence.'
      })
    ).toEqual({
      level: 'warn',
      text: '[call-capture] system lane silent omi-listen-1: The monitor of sink is at 8%, so call audio is recorded as silence.'
    })
    for (const system of ['delayed', 'unavailable'] as const) {
      expect(callAudioLogLine({ type: 'call-audio-status', sessionId: 's', system }).level).toBe(
        'warn'
      )
    }
  })

  it('logs the ordinary transitions plainly', () => {
    for (const system of ['opening', 'live', 'off'] as const) {
      expect(callAudioLogLine({ type: 'call-audio-status', sessionId: 's', system })).toEqual({
        level: 'log',
        text: `[call-capture] system lane ${system} s`
      })
    }
  })
})
