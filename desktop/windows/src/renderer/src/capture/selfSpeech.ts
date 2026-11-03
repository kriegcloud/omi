// Reports when the MIC lane alone carries speech, as positions in the fed stream,
// for a 'call' session (main's SpeakerTimeline turns them into "this segment was
// the user"). Runs its own Silero state on the mic samples of each mixed block, so
// the call side never counts as the user's speech.
//
// Fails quiet: if the model can't load or errors, no activity is reported and the
// segments simply stay unattributed. Transcription is unaffected.
import {
  createSileroDetector,
  SILERO_FRAME_SAMPLES,
  type SileroDetector
} from '../lib/capture/vadModel'
import { Float32Reblocker, SpeechHysteresis } from '../lib/capture/speechTicker'

export type SelfSpeechTracker = {
  /** Mic samples that start at the next fed-stream position (blocks are contiguous). */
  push: (mic: Int16Array) => void
  stop: () => void
}

export function createSelfSpeechTracker(
  onTransition: (speaking: boolean, atSample: number) => void,
  detectorFactory: () => Promise<SileroDetector> = createSileroDetector
): SelfSpeechTracker {
  const reblock = new Float32Reblocker(SILERO_FRAME_SAMPLES)
  const hysteresis = new SpeechHysteresis()
  let frameIndex = 0
  let detector: SileroDetector | null = null
  let failed = false
  let stopped = false
  let chain: Promise<void> = Promise.resolve()

  const ready = detectorFactory()
    .then((d) => {
      detector = d
    })
    .catch((e) => {
      failed = true
      console.warn(
        '[self-speech] detector unavailable; segments stay unattributed:',
        (e as Error)?.message
      )
    })

  return {
    push: (mic: Int16Array): void => {
      if (stopped || failed) return
      for (const frame of reblock.push(mic)) {
        const at = frameIndex * SILERO_FRAME_SAMPLES
        frameIndex++
        // Sequential: transitions must be reported in stream order.
        chain = chain
          .then(async () => {
            await ready
            if (stopped || !detector) return
            const transition = hysteresis.feed(await detector.process(frame))
            if (transition === 'start') onTransition(true, at)
            else if (transition === 'end') onTransition(false, at + SILERO_FRAME_SAMPLES)
          })
          .catch(() => {
            failed = true
          })
      }
    },
    stop: (): void => {
      stopped = true
    }
  }
}
