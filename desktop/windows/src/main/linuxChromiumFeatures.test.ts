import { describe, expect, it } from 'vitest'
import { LINUX_DISABLED_FEATURES, mergeFeatureList } from './linuxChromiumFeatures'

describe('Linux Chromium features', () => {
  it('switches off WebRTC input-volume adjustment', () => {
    // The feature that let gain control write the sink monitor's volume to 8%.
    expect(LINUX_DISABLED_FEATURES).toContain('WebRtcAllowInputVolumeAdjustment')
  })

  it('builds the switch value from nothing', () => {
    expect(mergeFeatureList('', LINUX_DISABLED_FEATURES)).toBe('WebRtcAllowInputVolumeAdjustment')
  })

  it('keeps the features a launcher already disabled', () => {
    expect(mergeFeatureList('Vulkan, UseSkiaRenderer', ['WebRtcAllowInputVolumeAdjustment'])).toBe(
      'Vulkan,UseSkiaRenderer,WebRtcAllowInputVolumeAdjustment'
    )
  })

  it('does not repeat a feature that is already listed', () => {
    expect(
      mergeFeatureList('WebRtcAllowInputVolumeAdjustment,Vulkan', [
        'WebRtcAllowInputVolumeAdjustment'
      ])
    ).toBe('WebRtcAllowInputVolumeAdjustment,Vulkan')
  })
})
