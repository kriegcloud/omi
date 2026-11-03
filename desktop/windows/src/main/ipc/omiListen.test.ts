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
    expect(buildListenHeaders('firebase-token', 'a1b2c3d4', 'linux')['X-App-Platform']).toBe('linux')
    expect(listenAppPlatform('darwin')).toBe('macos')
    expect(listenAppPlatform('win32')).toBe('windows')
  })
})
