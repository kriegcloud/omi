// Client-side "was this segment the user?" for a 'call' session (mic + system
// audio mixed to mono upstream). The capture window reports when the MIC lane
// alone carried speech, as sample positions of the fed stream; this maps each
// backend segment's offsets onto those positions and measures the overlap.
//
// Time base (measured 2026-11-02, docs/speaker-identity.md "Phase 0"): a segment's
// start/end are conversation-offset seconds. Within one socket the offset advances
// only with received audio; each socket anchors at its first audio byte to the time
// elapsed since the conversation started; parakeet's start runs ~0.35 s early.
// Call sessions stream ungated, so received audio == fed samples.

const SAMPLE_RATE = 16000
/** Parakeet reported segment starts 0.22-0.45 s before the audio (Phase 0). */
export const PARAKEET_LEAD_SEC = 0.35
/** Keep at most this many closed spans (an hour of brisk turn-taking). */
const MAX_SPANS = 4000

export type SegmentAttribution = 'self' | 'other'

/** ≥60% of the segment was the user's mic → self; ≤15% → the call side. */
export function attributeCoverage(coverage: number | null): SegmentAttribution | null {
  if (coverage === null) return null
  if (coverage >= 0.6) return 'self'
  if (coverage <= 0.15) return 'other'
  return null
}

export class SpeakerTimeline {
  private fed = 0
  private anchored = false
  private anchorSample = 0
  private anchorSec = 0
  private readonly spans: Array<[number, number]> = []
  private openStart: number | null = null

  /** @param conversationStartMs wall time the server conversation began (its first socket's open). */
  constructor(
    private readonly conversationStartMs: number,
    private readonly leadSec: number = PARAKEET_LEAD_SEC
  ) {}

  /** Audio actually sent to the server. The first send anchors this socket. */
  noteFed(samples: number, nowMs: number): void {
    if (!this.anchored) {
      this.anchored = true
      this.anchorSample = this.fed
      this.anchorSec = Math.max(0, (nowMs - this.conversationStartMs) / 1000)
    }
    this.fed += samples
  }

  /** The server opened a new conversation on this socket: offsets restart there. */
  noteConversationChanged(): void {
    this.anchored = true
    this.anchorSample = this.fed
    this.anchorSec = 0
  }

  /** Mic-lane speech transition at a fed-stream sample position. */
  noteActivity(speaking: boolean, atSample: number): void {
    if (speaking) {
      if (this.openStart === null) this.openStart = atSample
      return
    }
    if (this.openStart === null) return
    if (atSample > this.openStart) this.spans.push([this.openStart, atSample])
    this.openStart = null
    if (this.spans.length > MAX_SPANS) this.spans.splice(0, this.spans.length - MAX_SPANS)
  }

  /** Fraction of [startSec, endSec) covered by the user's own speech; null when the
   *  segment can't be mapped yet (socket not anchored, or degenerate range). */
  selfCoverage(startSec: number, endSec: number): number | null {
    if (!this.anchored || !(endSec > startSec)) return null
    const toSample = (t: number): number =>
      this.anchorSample + (t + this.leadSec - this.anchorSec) * SAMPLE_RATE
    const a = Math.max(this.anchorSample, toSample(startSec))
    const b = Math.min(this.fed, toSample(endSec))
    if (!(b > a)) return null
    let covered = 0
    for (const [s, e] of this.spans) {
      if (e <= a) continue
      if (s >= b) break
      covered += Math.min(e, b) - Math.max(s, a)
    }
    if (this.openStart !== null && this.openStart < b) {
      covered += b - Math.max(this.openStart, a)
    }
    return Math.min(1, covered / (b - a))
  }
}
