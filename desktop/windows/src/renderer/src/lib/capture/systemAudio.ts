// System-audio (loopback) capture, extracted from omiListenClient.ts so the capture
// layer owns every getUserMedia/getDisplayMedia entry point in one place. The
// loopback comes back via getDisplayMedia with the video track requested
// (audio-only display capture is rejected), so we grab audio then immediately drop
// the video track.

/**
 * Audio constraints for the loopback request.
 *
 * Linux: ask for the raw stream. A bare `audio: true` on getDisplayMedia turns on
 * Chromium's microphone processing (echo cancellation, noise suppression and
 * automatic gain control), and on Linux the gain control's input-volume half
 * writes the PulseAudio volume of the device the stream records. For a loopback
 * that device is the default sink's monitor source: Chromium reads the applied
 * volume as 0 for a loopback stream (PulseLoopbackAudioStream never starts the
 * wrapped stream's volume polling), WebRTC's InputVolumeController answers a 0 at
 * startup by raising it to its minimum of 20/255, and Chromium writes that to the
 * monitor. The monitor then sits at 8% (-66 dB) and the other side of a call is
 * recorded as silence, also for every other recorder on the machine and after the
 * app exits (observed 2026-11-12, Chromium 142). Digital playback needs none of
 * that processing anyway.
 *
 * Other platforms keep the request they have always made.
 */
export function systemAudioConstraints(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): MediaTrackConstraints | true {
  if (!/linux/i.test(userAgent)) return true
  return { autoGainControl: false, echoCancellation: false, noiseSuppression: false }
}

/** Capture the system/loopback audio as a mic-shaped MediaStream (audio tracks
 *  only). Throws with actionable text when the main-process display-media handler
 *  isn't active or the platform yields no loopback track. */
export async function getSystemAudioStream(): Promise<MediaStream> {
  let display: MediaStream
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: systemAudioConstraints()
    })
  } catch (e) {
    const err = e as Error
    if (/not supported/i.test(err.message)) {
      throw new Error(
        'System-audio capture handler not active. Fully restart the app (stop and rerun `npm run dev`) so the main process reloads.'
      )
    }
    throw e
  }
  const audioTracks = display.getAudioTracks()
  display.getVideoTracks().forEach((t) => t.stop())
  if (audioTracks.length === 0) {
    throw new Error('The platform returned no system-audio (loopback) track.')
  }
  return new MediaStream(audioTracks)
}
