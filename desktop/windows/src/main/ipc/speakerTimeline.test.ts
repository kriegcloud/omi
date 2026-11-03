import { describe, expect, it } from 'vitest'
import { SpeakerTimeline, attributeCoverage } from './speakerTimeline'

const SR = 16000

describe('SpeakerTimeline', () => {
  it('maps a segment onto mic speech in the first socket (lead-corrected)', () => {
    // Conversation opens at t=0; first audio 1.5 s later; 10 s streamed.
    const tl = new SpeakerTimeline(0, 0.35)
    tl.noteFed(SR, 1500)
    for (let i = 1; i < 10; i++) tl.noteFed(SR, 1500 + i * 1000)
    // The user spoke from fed sample 2 s to 5 s.
    tl.noteActivity(true, 2 * SR)
    tl.noteActivity(false, 5 * SR)
    // Server reports it 0.35 s early, offset by the 1.5 s anchor: 3.15..6.15.
    expect(tl.selfCoverage(3.15, 6.15)).toBeCloseTo(1, 5)
    // A later segment (fed 6..9 s) is the call side.
    expect(tl.selfCoverage(7.15, 10.15)).toBe(0)
  })

  it('counts an open span up to what has been fed', () => {
    const tl = new SpeakerTimeline(0, 0)
    tl.noteFed(4 * SR, 0)
    tl.noteActivity(true, 2 * SR)
    expect(tl.selfCoverage(0, 4)).toBeCloseTo(0.5, 5)
  })

  it('re-anchors after the server starts a new conversation on the socket', () => {
    const tl = new SpeakerTimeline(0, 0)
    tl.noteFed(10 * SR, 0)
    tl.noteConversationChanged()
    tl.noteFed(5 * SR, 10_000)
    tl.noteActivity(true, 11 * SR)
    tl.noteActivity(false, 13 * SR)
    // New conversation offsets start at fed sample 10 s.
    expect(tl.selfCoverage(1, 3)).toBeCloseTo(1, 5)
  })

  it('returns null before any audio was sent or for empty ranges', () => {
    const tl = new SpeakerTimeline(0)
    expect(tl.selfCoverage(0, 1)).toBeNull()
    tl.noteFed(SR, 0)
    expect(tl.selfCoverage(0.5, 0.5)).toBeNull()
  })
})

describe('attributeCoverage', () => {
  it('needs a clear majority either way', () => {
    expect(attributeCoverage(0.8)).toBe('self')
    expect(attributeCoverage(0.1)).toBe('other')
    expect(attributeCoverage(0.4)).toBeNull()
    expect(attributeCoverage(null)).toBeNull()
  })
})
