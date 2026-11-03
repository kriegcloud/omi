import { describe, expect, it } from 'vitest'
import { buildListenHeaders, listenAppPlatform } from './omiListen'

describe('Windows listen transport', () => {
  it('adds device provenance to the authenticated WebSocket upgrade', () => {
    expect(buildListenHeaders('firebase-token', 'a1b2c3d4', 'win32')).toEqual({
      Authorization: 'Bearer firebase-token',
      'X-App-Platform': 'windows',
      'X-Device-Id-Hash': 'a1b2c3d4'
    })
  })

  it('reports the real OS instead of claiming windows on Linux', () => {
    expect(buildListenHeaders('firebase-token', 'a1b2c3d4', 'linux')['X-App-Platform']).toBe(
      'linux'
    )
    expect(listenAppPlatform('darwin')).toBe('macos')
    expect(listenAppPlatform('win32')).toBe('windows')
  })
})

describe('two-channel call sockets', () => {
  it('opens /v4/listen with channels=2 only when asked', async () => {
    const { buildListenEndpoint } = await import('./omiListen')
    expect(buildListenEndpoint('conversation', 'en')).toContain('&channels=1&')
    expect(buildListenEndpoint('conversation', 'en', undefined, 2)).toContain('&channels=2&')
    expect(buildListenEndpoint('transcribe', 'en', undefined, 2)).toContain('&channels=1')
  })

  it('prefixes call frames with the channel id and drops unlabelled ones', async () => {
    const { frameListenAudio } = await import('./omiListen')
    const pcm = new Int16Array([1, -1]).buffer
    expect(frameListenAudio(1, pcm)).toBe(pcm)
    const mic = frameListenAudio(2, pcm, 0x01) as Buffer
    expect([...mic]).toEqual([0x01, 0x01, 0x00, 0xff, 0xff])
    expect((frameListenAudio(2, pcm, 0x02) as Buffer)[0]).toBe(0x02)
    expect(frameListenAudio(2, pcm)).toBeNull()
    expect(frameListenAudio(2, pcm, 0x03)).toBeNull()
  })
})
