import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetCallAudioForTest, replayCallAudio, reportCallAudio } from './callAudioStatus'

const captureEmit = vi.fn()
const emitted = (): unknown[] => captureEmit.mock.calls.map(([event]) => event)

beforeEach(() => {
  captureEmit.mockReset()
  vi.stubGlobal('window', { omi: { captureEmit } })
  _resetCallAudioForTest()
})

describe('call-audio status', () => {
  it('emits each report as a call-audio-status event', () => {
    reportCallAudio('s1', 'opening')
    reportCallAudio('s1', 'unavailable', 'no loopback')
    expect(emitted()).toEqual([
      { type: 'call-audio-status', sessionId: 's1', system: 'opening' },
      { type: 'call-audio-status', sessionId: 's1', system: 'unavailable', detail: 'no loopback' }
    ])
  })

  it('replays the current state of a session, not its history', () => {
    reportCallAudio('s1', 'opening')
    reportCallAudio('s1', 'live')
    reportCallAudio('s1', 'silent', 'monitor at 8%')
    captureEmit.mockClear()
    replayCallAudio()
    expect(emitted()).toEqual([
      { type: 'call-audio-status', sessionId: 's1', system: 'silent', detail: 'monitor at 8%' }
    ])
  })

  it('replays nothing for a session that ended', () => {
    reportCallAudio('s1', 'live')
    reportCallAudio('s1', 'off')
    captureEmit.mockClear()
    replayCallAudio()
    expect(emitted()).toEqual([])
  })

  it('replays the most recent report last, so that is what the UI ends on', () => {
    reportCallAudio('fallback', 'unavailable', 'refused')
    reportCallAudio('s2', 'opening')
    reportCallAudio('fallback', 'unavailable', 'refused') // reported again: now the latest
    captureEmit.mockClear()
    replayCallAudio()
    expect(emitted().map((e) => (e as { sessionId: string }).sessionId)).toEqual(['s2', 'fallback'])
  })

  it('does not throw where the window has no capture bridge', () => {
    vi.stubGlobal('window', { omi: {} })
    expect(() => reportCallAudio('s1', 'live')).not.toThrow()
    expect(() => replayCallAudio()).not.toThrow()
  })
})
