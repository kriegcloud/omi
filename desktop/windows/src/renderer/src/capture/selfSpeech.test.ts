import { describe, expect, it, vi } from 'vitest'

// Keep onnxruntime out of the unit test: the tracker takes an injected detector.
vi.mock('../lib/capture/vadModel', () => ({
  SILERO_FRAME_SAMPLES: 512,
  createSileroDetector: async () => ({ process: async () => 0 })
}))

import { createSelfSpeechTracker } from './selfSpeech'
const SILERO_FRAME_SAMPLES = 512

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createSelfSpeechTracker', () => {
  it('reports mic speech transitions at fed-stream sample positions', async () => {
    // Fake detector: frames whose first sample is non-zero are speech.
    const detector = {
      process: async (f: Float32Array): Promise<number> => (f[0] !== 0 ? 0.9 : 0.05)
    }
    const events: Array<[boolean, number]> = []
    const t = createSelfSpeechTracker(
      (s, at) => events.push([s, at]),
      async () => detector
    )
    const n = SILERO_FRAME_SAMPLES
    t.push(new Int16Array(2 * n)) // silence: frames 0-1
    t.push(new Int16Array(3 * n).fill(1000)) // speech: frames 2-4
    t.push(new Int16Array(2 * n)) // silence: frames 5-6
    for (let i = 0; i < 20; i++) await settle()
    expect(events).toEqual([
      [true, 2 * n],
      [false, 6 * n]
    ])
  })

  it('stays silent when the model fails to load', async () => {
    const events: unknown[] = []
    const t = createSelfSpeechTracker(
      () => events.push(1),
      async () => {
        throw new Error('no model')
      }
    )
    t.push(new Int16Array(4 * SILERO_FRAME_SAMPLES).fill(1000))
    for (let i = 0; i < 10; i++) await settle()
    expect(events).toEqual([])
  })
})
