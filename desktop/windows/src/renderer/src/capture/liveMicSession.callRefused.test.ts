import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TranscriptionCallbacks } from '../lib/transcriptionClient'

// When the backend refuses the call source the live session carries on with the
// mic alone. No call session exists then, so the session itself has to keep the
// "mic only" warning up until call capture is retried or switched off.

type Call = { source: string; cb: TranscriptionCallbacks }
const calls: Call[] = []
const reportCallAudio = vi.fn()
const prefs = { callCaptureEnabled: true }
let onPrefs: ((p: typeof prefs) => void) | null = null

vi.mock('../lib/transcriptionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transcriptionClient')>()
  return {
    ...actual,
    startTranscription: vi.fn(async (source: string, cb: TranscriptionCallbacks) => {
      calls.push({ source, cb })
      return { stop: vi.fn(), finalize: vi.fn() }
    })
  }
})
vi.mock('../lib/liveConversation', () => ({
  isConversationBoundary: () => false,
  onFinalizeRequest: () => () => {}
}))
vi.mock('../lib/retentionRules', () => ({ transcriptWordCount: () => 0 }))
vi.mock('../lib/voice/injectedTranscript', () => ({ isInjectedLineId: () => false }))
vi.mock('./liveStore', () => ({
  captureLiveStore: {
    reset: vi.fn(),
    setStatus: vi.fn(),
    appendLine: vi.fn(),
    saved: vi.fn(),
    getSegments: () => []
  }
}))
vi.mock('../lib/sync/conversationSync', () => ({ syncLocalConversation: vi.fn() }))
vi.mock('../lib/preferences', () => ({
  getPreferences: () => prefs,
  onPreferencesChange: (cb: (p: typeof prefs) => void) => {
    onPrefs = cb
    return () => {
      onPrefs = null
    }
  }
}))
vi.mock('./callAudioStatus', () => ({
  reportCallAudio: (...args: unknown[]) => reportCallAudio(...args)
}))

import { CALL_REFUSED_DETAIL, startLiveMicSession } from './liveMicSession'

const REFUSED = new Error('v4/listen closed (1011) transcription_service_unavailable')
const latest = (): Call => calls[calls.length - 1]
const reports = (): Array<[string, string, string | undefined]> =>
  reportCallAudio.mock.calls as Array<[string, string, string | undefined]>

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  calls.length = 0
  reportCallAudio.mockReset()
  prefs.callCaptureEnabled = true
  vi.stubGlobal('window', { omi: {} })
  if (!globalThis.crypto?.randomUUID) {
    let n = 0
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${n++}` })
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Start a session on the call source and have the backend refuse it. */
async function startAndRefuse(): Promise<ReturnType<typeof startLiveMicSession>> {
  const ctrl = startLiveMicSession()
  await vi.advanceTimersByTimeAsync(0)
  expect(latest().source).toBe('call')
  latest().cb.onError(REFUSED)
  return ctrl
}

describe('live session after the backend refuses call capture', () => {
  it('reports that it is recording the mic only, and keeps saying so on the mic', async () => {
    const ctrl = await startAndRefuse()
    expect(reports()).toHaveLength(1)
    const [id, state, detail] = reports()[0]
    expect(id).toMatch(/call-refused$/)
    expect([state, detail]).toEqual(['unavailable', CALL_REFUSED_DETAIL])

    await vi.advanceTimersByTimeAsync(60_000) // the reconnect
    expect(latest().source).toBe('mic')
    latest().cb.onBackend('omi') // live again, on the mic
    expect(reports()).toHaveLength(1) // nothing has taken the warning down
    ctrl.stop()
  })

  it('takes the warning down when call capture is switched off', async () => {
    const ctrl = await startAndRefuse()
    await vi.advanceTimersByTimeAsync(60_000)
    const [id] = reports()[0]
    prefs.callCaptureEnabled = false
    onPrefs?.(prefs)
    expect(reports().at(-1)).toEqual([id, 'off'])
    expect(latest().source).toBe('mic') // already on the mic: no restart
    ctrl.stop()
    expect(reports()).toHaveLength(2) // and no second 'off'
  })

  it('takes the warning down when call capture is retried', async () => {
    const ctrl = await startAndRefuse()
    await vi.advanceTimersByTimeAsync(60_000)
    const [id] = reports()[0]
    onPrefs?.(prefs) // a preference change with call capture still on retries the pair
    expect(reports().at(-1)).toEqual([id, 'off'])
    await vi.advanceTimersByTimeAsync(0)
    expect(latest().source).toBe('call') // whose own session reports from here
    ctrl.stop()
  })

  it('takes the warning down when the session stops', async () => {
    const ctrl = await startAndRefuse()
    const [id] = reports()[0]
    ctrl.stop()
    expect(reports().at(-1)).toEqual([id, 'off'])
  })

  it('reports nothing for an ordinary drop', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onError(new Error('v4/listen closed (1006)'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(latest().source).toBe('call') // reconnected on the same source
    ctrl.stop()
    expect(reports()).toEqual([])
  })
})
