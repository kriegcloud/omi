import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSystemAudioStream, systemAudioConstraints } from './systemAudio'

const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) omi-windows/1.0.35 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) omi-windows/1.0.35 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('systemAudioConstraints', () => {
  it('asks for the unprocessed loopback on Linux', () => {
    // Gain control on a loopback rewrites the sink monitor's volume (8%, -66 dB),
    // so none of the microphone processing may be on.
    expect(systemAudioConstraints(LINUX_UA)).toEqual({
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false
    })
  })

  it('leaves the request as it was elsewhere', () => {
    expect(systemAudioConstraints(WINDOWS_UA)).toBe(true)
  })
})

describe('getSystemAudioStream', () => {
  function stubDisplayMedia(userAgent: string): ReturnType<typeof vi.fn> {
    const videoStop = vi.fn()
    const audioTrack = { kind: 'audio' }
    const getDisplayMedia = vi.fn(async () => ({
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [{ stop: videoStop }]
    }))
    vi.stubGlobal('navigator', { userAgent, mediaDevices: { getDisplayMedia } })
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(readonly tracks: unknown[]) {}
      }
    )
    return getDisplayMedia
  }

  it('sends the Linux constraints with the display-media request', async () => {
    const getDisplayMedia = stubDisplayMedia(LINUX_UA)
    const stream = (await getSystemAudioStream()) as unknown as { tracks: unknown[] }
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }
    })
    expect(stream.tracks).toEqual([{ kind: 'audio' }]) // audio only: the video track is dropped
  })

  it('keeps the plain request on Windows', async () => {
    const getDisplayMedia = stubDisplayMedia(WINDOWS_UA)
    await getSystemAudioStream()
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true })
  })
})
