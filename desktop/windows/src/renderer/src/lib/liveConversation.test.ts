import { it, expect, beforeEach, describe } from 'vitest'
import {
  callAudioWarning,
  liveConversation,
  liveStatusLabel,
  isConversationBoundary
} from './liveConversation'
import type { TranscriptLine } from '../../../shared/types'

beforeEach(() => {
  liveConversation.reset()
  liveConversation.clearCallAudio()
})

it('starts idle and empty', () => {
  expect(liveConversation.getSegments()).toEqual([])
  expect(liveConversation.getStatus()).toBe('idle')
})

it('appendLine adds segments and notifies subscribers', () => {
  let calls = 0
  const unsub = liveConversation.subscribe(() => {
    calls++
  })
  liveConversation.appendLine({ text: 'hello', speaker: 'You' })
  liveConversation.appendLine({ text: 'world' })
  expect(liveConversation.getSegments().map((s) => s.text)).toEqual(['hello', 'world'])
  expect(calls).toBe(2)
  unsub()
})

it('reset clears segments and sets idle', () => {
  liveConversation.setStatus('live')
  liveConversation.appendLine({ text: 'x' })
  liveConversation.reset()
  expect(liveConversation.getSegments()).toEqual([])
  expect(liveConversation.getStatus()).toBe('idle')
})

it('isConversationBoundary detects memory_creating only', () => {
  expect(isConversationBoundary({ type: 'memory_creating', raw: {} })).toBe(true)
  expect(isConversationBoundary({ type: 'last_audio_bytes', raw: {} })).toBe(false)
  expect(isConversationBoundary({ type: 'freemium_threshold_reached', raw: {} })).toBe(false)
})

// applyRemoteOp is how a UI window mirrors the capture window's live-conversation
// store, so the LiveConversation view shows a session running in another window.
describe('applyRemoteOp', () => {
  const line = (id: string, text: string): TranscriptLine => ({ id, speaker: 'You', text })

  it('mirrors status transitions and clears the error on recovery', () => {
    liveConversation.applyRemoteOp({ op: 'status', status: 'connecting' })
    expect(liveConversation.getStatus()).toBe('connecting')
    liveConversation.applyRemoteOp({ op: 'status', status: 'error', error: 'boom' })
    expect(liveConversation.getError()).toBe('boom')
    liveConversation.applyRemoteOp({ op: 'status', status: 'live' })
    expect(liveConversation.getError()).toBeNull()
  })

  it('appends and upserts lines by id', () => {
    liveConversation.applyRemoteOp({ op: 'append', line: line('a', 'hello') })
    liveConversation.applyRemoteOp({ op: 'append', line: line('b', 'world') })
    liveConversation.applyRemoteOp({ op: 'append', line: line('a', 'hello there') })
    expect(liveConversation.getSegments().map((s) => s.text)).toEqual(['hello there', 'world'])
  })

  it('snaps to the saved segments, flags saved, then clears on the next append', () => {
    liveConversation.applyRemoteOp({ op: 'append', line: line('a', 'hi') })
    const saved = [line('a', 'hi'), line('b', 'bye')]
    liveConversation.applyRemoteOp({ op: 'saved', segments: saved })
    expect(liveConversation.isSaved()).toBe(true)
    expect(liveConversation.getSegments()).toEqual(saved)
    liveConversation.applyRemoteOp({ op: 'append', line: line('c', 'next') })
    expect(liveConversation.isSaved()).toBe(false)
    expect(liveConversation.getSegments().map((s) => s.text)).toEqual(['next'])
  })

  it('resets', () => {
    liveConversation.applyRemoteOp({ op: 'append', line: line('a', 'hi') })
    liveConversation.applyRemoteOp({ op: 'reset' })
    expect(liveConversation.getSegments()).toEqual([])
    expect(liveConversation.getStatus()).toBe('idle')
  })
})

// A 'call' session's system lane (the other side of a call), mirrored from the
// capture window's call-audio-status events.
describe('call audio', () => {
  it('holds the latest lane state and notifies subscribers', () => {
    let calls = 0
    const unsub = liveConversation.subscribe(() => {
      calls++
    })
    liveConversation.applyCallAudio({ sessionId: 's1', system: 'opening' })
    liveConversation.applyCallAudio({ sessionId: 's1', system: 'silent', detail: 'monitor at 8%' })
    expect(liveConversation.getCallAudio()).toEqual({
      sessionId: 's1',
      system: 'silent',
      detail: 'monitor at 8%'
    })
    expect(calls).toBe(2)
    unsub()
  })

  it("ends on the session's own 'off', not on its predecessor's", () => {
    liveConversation.applyCallAudio({ sessionId: 's2', system: 'live' })
    liveConversation.applyCallAudio({ sessionId: 's1', system: 'off' }) // a late stop
    expect(liveConversation.getCallAudio()?.sessionId).toBe('s2')
    liveConversation.applyCallAudio({ sessionId: 's2', system: 'off' })
    expect(liveConversation.getCallAudio()).toBeNull()
  })

  it('survives a transcript reset and is dropped when the capture window restarts', () => {
    liveConversation.applyCallAudio({ sessionId: 's1', system: 'unavailable' })
    liveConversation.reset()
    expect(liveConversation.getCallAudio()?.system).toBe('unavailable')
    liveConversation.clearCallAudio()
    expect(liveConversation.getCallAudio()).toBeNull()
  })

  it('counts delayed, silent and unavailable as warnings', () => {
    const state = (system: 'opening' | 'delayed' | 'live' | 'silent' | 'unavailable') => ({
      sessionId: 's1',
      system,
      detail: null
    })
    expect(callAudioWarning(null)).toBeNull()
    expect(callAudioWarning(state('opening'))).toBeNull()
    expect(callAudioWarning(state('live'))).toBeNull()
    for (const system of ['delayed', 'silent', 'unavailable'] as const) {
      expect(callAudioWarning(state(system))?.system).toBe(system)
    }
  })

  it('does not label a session missing its call audio as plain Listening', () => {
    const state = (system: 'live' | 'delayed' | 'silent' | 'unavailable') => ({
      sessionId: 's1',
      system,
      detail: null
    })
    expect(liveStatusLabel('live')).toBe('Listening')
    expect(liveStatusLabel('live', state('live'))).toBe('Listening')
    expect(liveStatusLabel('live', state('silent'))).toBe('Listening (no call audio)')
    expect(liveStatusLabel('live', state('delayed'))).toBe('Listening (mic only)')
    expect(liveStatusLabel('live', state('unavailable'))).toBe('Listening (mic only)')
    // Other statuses keep their own word whatever the lane says.
    expect(liveStatusLabel('connecting', state('silent'))).toBe('Connecting…')
    expect(liveStatusLabel('error', state('silent'))).toBe('Microphone unavailable')
    expect(liveStatusLabel('idle')).toBe('Idle')
  })
})
