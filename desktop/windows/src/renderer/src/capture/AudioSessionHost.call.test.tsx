// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureCommand, CaptureEvent, CallSystemLaneState } from '../../../shared/types'
import type { PipelineSetupResult } from '../lib/capture/pipelineHandle'

// 'call' sessions: the mic lane alone decides readiness, the system loopback joins
// when it opens, and every state of the loopback is reported.

type FakeStream = { name: string; trackStop: ReturnType<typeof vi.fn> }
type FakePipeline = {
  stream: FakeStream
  onChunk: (pcm: Int16Array) => void
  stop: ReturnType<typeof vi.fn>
}
type WatchOptions = { onState: (state: 'silent' | 'live', detail?: string) => void }

const h = vi.hoisted(() => ({
  commandHandler: null as null | ((command: CaptureCommand, ownerId: number) => void),
  captureEmit: vi.fn(),
  listenFeed: vi.fn(),
  acquireMic: vi.fn(),
  openSystem: vi.fn(),
  pipelines: [] as FakePipeline[],
  // Setup result per stream name; a stream without an entry sets up fine.
  setups: new Map<string, Promise<PipelineSetupResult>>(),
  watchOptions: null as WatchOptions | null,
  watchPush: vi.fn(),
  watchStop: vi.fn()
}))

vi.mock('../lib/audio', () => ({ acquireMicStream: () => h.acquireMic() }))
vi.mock('../lib/capture/systemAudio', () => ({ getSystemAudioStream: () => h.openSystem() }))
vi.mock('../lib/capture/captureEngine', () => ({
  createPcmPipeline: (
    stream: FakeStream & { getTracks: () => Array<{ stop: () => void }> },
    onChunk: (pcm: Int16Array) => void
  ) => {
    const pipeline = { stream, onChunk, stop: vi.fn() }
    h.pipelines.push(pipeline)
    return {
      stop: pipeline.stop,
      ready: h.setups.get(stream.name) ?? Promise.resolve({ ok: true })
    }
  },
  createVadGate: () => ({ push: vi.fn(), stop: vi.fn() })
}))
vi.mock('../lib/capture/loopbackMusicFilter', () => ({
  createLoopbackMusicFilter: () => ({ push: vi.fn(), stop: vi.fn(), verdict: vi.fn() })
}))
vi.mock('../lib/preferences', () => ({ getPreferences: () => ({ vadGateEnabled: true }) }))
vi.mock('../lib/capture/vadGate', () => ({ resolveVadGateMode: () => 'gated' }))
vi.mock('./assistantGate', () => ({
  assistantGate: { setSpeaking: vi.fn(), isPaused: () => false },
  wrapFeed: (feed: unknown) => feed
}))
vi.mock('./selfSpeech', () => ({
  createSelfSpeechTracker: () => ({ push: vi.fn(), stop: vi.fn() })
}))
vi.mock('./systemLaneWatch', () => ({
  createSystemLaneWatch: (options: WatchOptions) => {
    h.watchOptions = options
    return { push: h.watchPush, stop: h.watchStop }
  }
}))

import {
  AudioSessionHost,
  CALL_SYSTEM_LANE_DELAYED_MS,
  CALL_SYSTEM_LANE_RETRY_MS
} from './AudioSessionHost'

const OWNER = 42

function makeStream(name: string): FakeStream & { getTracks: () => Array<{ stop: () => void }> } {
  const trackStop = vi.fn()
  return { name, trackStop, getTracks: () => [{ stop: trackStop }] }
}
const pcm = (value: number): Int16Array => new Int16Array(1600).fill(value)
const events = (): CaptureEvent[] =>
  h.captureEmit.mock.calls.map(([event]) => event as CaptureEvent)
const laneEvents = (id: string): Array<Extract<CaptureEvent, { type: 'call-audio-status' }>> =>
  events().filter(
    (e): e is Extract<CaptureEvent, { type: 'call-audio-status' }> =>
      e.type === 'call-audio-status' && e.sessionId === id
  )
const lane = (id: string): CallSystemLaneState[] => laneEvents(id).map((e) => e.system)
const readyCount = (id: string): number =>
  events().filter((e) => e.type === 'audio-source-ready' && e.sessionId === id).length
const errors = (): CaptureEvent[] => events().filter((e) => e.type === 'audio-source-error')
/** The mono blocks fed upstream, as [first sample, length]. */
const fed = (): Array<[number, number]> =>
  h.listenFeed.mock.calls.map(([, buffer]) => {
    const block = new Int16Array(buffer as ArrayBuffer)
    return [block[0], block.length]
  })
const start = (id: string): void =>
  h.commandHandler?.({ type: 'audio-start', sessionId: id, source: 'call' }, OWNER)
const stop = (id: string): void => h.commandHandler?.({ type: 'audio-stop', sessionId: id }, OWNER)
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0)
/** A loopback request the test resolves by hand. */
function pendingSystem(): { open: (stream: ReturnType<typeof makeStream>) => void } {
  let open!: (stream: ReturnType<typeof makeStream>) => void
  h.openSystem.mockReturnValue(new Promise((resolve) => (open = resolve)))
  return { open: (stream) => open(stream) }
}

beforeEach(() => {
  vi.useFakeTimers()
  h.commandHandler = null
  h.captureEmit.mockReset()
  h.listenFeed.mockReset()
  h.acquireMic.mockReset().mockImplementation(async () => makeStream('mic'))
  h.openSystem.mockReset().mockImplementation(async () => makeStream('system'))
  h.pipelines.length = 0
  h.setups.clear()
  h.watchOptions = null
  h.watchPush.mockReset()
  h.watchStop.mockReset()
  Object.defineProperty(window, 'omi', {
    configurable: true,
    value: {
      listenFeed: h.listenFeed,
      listenActivity: vi.fn(),
      captureEmit: h.captureEmit,
      systemPlaybackProbe: vi.fn(),
      onCaptureCommand: (handler: (command: CaptureCommand, ownerId: number) => void) => {
        h.commandHandler = handler
        return () => {
          h.commandHandler = null
        }
      }
    }
  })
  render(<AudioSessionHost />)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('call session startup', () => {
  it('is ready on the mic while the loopback request is still pending', async () => {
    pendingSystem()
    start('pending')
    await settle()

    expect(h.captureEmit).toHaveBeenCalledWith(
      { type: 'audio-source-ready', sessionId: 'pending' },
      OWNER
    )
    expect(lane('pending')).toEqual(['opening'])
    // The mic is already being recorded.
    h.pipelines[0].onChunk(pcm(10))
    expect(fed()).toEqual([[10, 1600]])
    stop('pending')
  })

  it('waits out a loopback that takes a minute instead of failing the session', async () => {
    const system = pendingSystem()
    start('slow')
    await vi.advanceTimersByTimeAsync(CALL_SYSTEM_LANE_DELAYED_MS)
    expect(lane('slow')).toEqual(['opening', 'delayed'])
    expect(laneEvents('slow')[1].detail).toMatch(/microphone only/)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(readyCount('slow')).toBe(1)
    expect(errors()).toEqual([])
    expect(h.openSystem).toHaveBeenCalledTimes(1) // waited for, not asked again

    system.open(makeStream('system'))
    await settle()
    expect(lane('slow')).toEqual(['opening', 'delayed', 'live'])
    stop('slow')
  })

  it('mixes the loopback in once it opens', async () => {
    const system = pendingSystem()
    start('mix')
    await settle()
    h.pipelines[0].onChunk(pcm(10)) // mic only so far
    system.open(makeStream('system'))
    await settle()

    const [micLane, systemLane] = h.pipelines
    expect(systemLane.stream.name).toBe('system')
    micLane.onChunk(pcm(10))
    systemLane.onChunk(pcm(5))
    expect(fed()).toEqual([
      [10, 1600],
      [15, 1600]
    ])
    expect(h.watchPush).toHaveBeenCalledTimes(1) // the watch sees the system lane
    stop('mix')
  })

  it('keeps the session on the mic when the loopback fails, and retries it', async () => {
    h.openSystem.mockRejectedValueOnce(new Error('Could not start audio source'))
    start('retry')
    await settle()
    expect(lane('retry')).toEqual(['opening', 'unavailable'])
    expect(laneEvents('retry')[1].detail).toContain('Could not start audio source')
    expect(readyCount('retry')).toBe(1)
    expect(errors()).toEqual([])

    await vi.advanceTimersByTimeAsync(CALL_SYSTEM_LANE_RETRY_MS[0])
    expect(h.openSystem).toHaveBeenCalledTimes(2)
    expect(lane('retry')).toEqual(['opening', 'unavailable', 'live'])
    stop('retry')
  })

  it('stops retrying after the last attempt and stays on the mic', async () => {
    h.openSystem.mockRejectedValue(new Error('no loopback track'))
    start('gone')
    await vi.advanceTimersByTimeAsync(CALL_SYSTEM_LANE_RETRY_MS.reduce((a, b) => a + b, 0) + 60_000)
    expect(h.openSystem).toHaveBeenCalledTimes(CALL_SYSTEM_LANE_RETRY_MS.length + 1)
    expect(lane('gone').at(-1)).toBe('unavailable')
    expect(readyCount('gone')).toBe(1)
    expect(errors()).toEqual([])
    stop('gone')
    expect(lane('gone').at(-1)).toBe('off')
  })

  it('stays on the mic when the system pipeline cannot be set up', async () => {
    h.setups.set('system', Promise.resolve({ ok: false, error: new Error('audio graph failed') }))
    h.openSystem.mockImplementationOnce(async () => makeStream('system'))
    h.openSystem.mockReturnValue(new Promise(() => {})) // the retry stays pending
    start('graph')
    await settle()
    expect(lane('graph')).toEqual(['opening', 'unavailable'])
    expect(h.pipelines[1].stop).toHaveBeenCalledOnce()
    expect(errors()).toEqual([])
    stop('graph')
  })

  it('releases a loopback that opens after the session was stopped', async () => {
    const system = pendingSystem()
    start('stopped')
    await settle()
    stop('stopped')
    const late = makeStream('system')
    system.open(late)
    await vi.advanceTimersByTimeAsync(CALL_SYSTEM_LANE_DELAYED_MS * 2)

    expect(late.trackStop).toHaveBeenCalledOnce()
    expect(h.pipelines).toHaveLength(1) // no system pipeline was built
    expect(lane('stopped')).toEqual(['opening', 'off'])
  })

  it('still fails the session when the mic cannot be opened', async () => {
    h.acquireMic.mockRejectedValueOnce(new Error('mic busy'))
    start('nomic')
    await settle()
    expect(errors()).toEqual([
      { type: 'audio-source-error', sessionId: 'nomic', name: 'Error', message: 'mic busy' }
    ])
    expect(readyCount('nomic')).toBe(0)
    expect(h.openSystem).not.toHaveBeenCalled()
  })

  it('fails the session and drops the loopback when the mic pipeline cannot be set up', async () => {
    h.setups.set('mic', Promise.resolve({ ok: false, error: new Error('mic graph failed') }))
    const system = pendingSystem()
    start('micgraph')
    await settle()
    expect(errors()).toHaveLength(1)
    expect(readyCount('micgraph')).toBe(0)

    const late = makeStream('system')
    system.open(late)
    await settle()
    expect(late.trackStop).toHaveBeenCalledOnce()
    expect(lane('micgraph').at(-1)).toBe('off')
  })
})

describe('call session system-lane watch', () => {
  it('reports the watch verdicts as lane states until the session stops', async () => {
    start('watch')
    await settle()
    expect(lane('watch')).toEqual(['opening', 'live'])

    const detail = 'The monitor of sink is at 8%, so call audio is recorded as silence.'
    h.watchOptions?.onState('silent', detail)
    h.watchOptions?.onState('live')
    expect(laneEvents('watch').slice(2)).toEqual([
      { type: 'call-audio-status', sessionId: 'watch', system: 'silent', detail },
      { type: 'call-audio-status', sessionId: 'watch', system: 'live' }
    ])

    stop('watch')
    expect(h.watchStop).toHaveBeenCalledOnce()
    h.watchOptions?.onState('silent', detail) // a verdict that lands after the stop
    expect(lane('watch').at(-1)).toBe('off')
  })
})
