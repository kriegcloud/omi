// Mixes a call session's two capture lanes (mic + system loopback) into the one
// mono stream sent upstream, in fixed blocks, so every output sample has the mic
// sample that produced it at the same position. That alignment is what lets the
// mic lane's own speech activity be reported as fed-stream sample positions.
//
// The lanes are independent PCM pipelines and drift by a frame or two; a lane that
// stalls (stream suspended, device gone) must not hold the other back, so past
// `maxLagSamples` the missing lane is filled with silence.

export type MixedBlock = {
  /** Mono mix to feed upstream (mic + system, clipped to int16). */
  mix: Int16Array
  /** The mic lane's samples for exactly the same span. */
  mic: Int16Array
  /** Fed-stream sample index of this block's first sample. */
  startSample: number
}

export type CallLaneMixerOptions = {
  blockSamples: number
  maxLagSamples: number
  /** false while system audio is not open (yet): mic-only, mixed with silence.
   *  attachSystem() switches to mixing once the lane is up. */
  hasSystem: boolean
}

class LaneQueue {
  private chunks: Int16Array[] = []
  private offset = 0 // read position inside chunks[0]
  length = 0

  push(pcm: Int16Array): void {
    if (pcm.length === 0) return
    this.chunks.push(pcm)
    this.length += pcm.length
  }

  /** Take exactly n samples, zero-filling whatever the lane doesn't have. */
  take(n: number): Int16Array {
    const out = new Int16Array(n)
    let filled = 0
    while (filled < n && this.chunks.length > 0) {
      const head = this.chunks[0]
      const count = Math.min(n - filled, head.length - this.offset)
      out.set(head.subarray(this.offset, this.offset + count), filled)
      filled += count
      this.offset += count
      if (this.offset >= head.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    this.length -= filled
    return out
  }
}

export class CallLaneMixer {
  private readonly mic = new LaneQueue()
  private readonly system = new LaneQueue()
  private cursor = 0
  private hasSystem: boolean

  constructor(private readonly opts: CallLaneMixerOptions) {
    this.hasSystem = opts.hasSystem
  }

  /** The system lane opened after the session started on the mic alone. Blocks
   *  already emitted stay as they are; from here on the lanes are mixed. */
  attachSystem(): void {
    this.hasSystem = true
  }

  push(lane: 'mic' | 'system', pcm: Int16Array): MixedBlock[] {
    // System audio that arrives before the lane is attached has no place in the
    // stream (those spans were already emitted mic-only), and queueing it would
    // read as the mic lane having stalled.
    if (lane === 'system' && !this.hasSystem) return []
    ;(lane === 'mic' ? this.mic : this.system).push(pcm)
    const out: MixedBlock[] = []
    const n = this.opts.blockSamples
    for (;;) {
      const micReady = this.mic.length >= n
      const sysReady = !this.hasSystem || this.system.length >= n
      const micStalled = this.system.length - this.mic.length > this.opts.maxLagSamples
      const sysStalled = this.mic.length - this.system.length > this.opts.maxLagSamples
      if (
        !(
          (micReady && sysReady) ||
          (micReady && sysStalled) ||
          (sysReady && this.hasSystem && micStalled)
        )
      )
        break
      const mic = this.mic.take(n)
      const mix = new Int16Array(n)
      if (this.hasSystem) {
        const sys = this.system.take(n)
        for (let i = 0; i < n; i++) {
          const v = mic[i] + sys[i]
          mix[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
        }
      } else {
        mix.set(mic)
      }
      out.push({ mix, mic, startSample: this.cursor })
      this.cursor += n
    }
    return out
  }
}
