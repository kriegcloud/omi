import { describe, expect, it } from 'vitest'
import { CallLaneMixer } from './callMixer'

const fill = (n: number, v: number): Int16Array => new Int16Array(n).fill(v)

describe('CallLaneMixer', () => {
  it('emits aligned blocks once both lanes have a block', () => {
    const m = new CallLaneMixer({ blockSamples: 4, maxLagSamples: 100, hasSystem: true })
    expect(m.push('mic', fill(6, 10))).toEqual([])
    const out = m.push('system', fill(6, 5))
    expect(out).toHaveLength(1)
    expect([...out[0].mix]).toEqual([15, 15, 15, 15])
    expect([...out[0].mic]).toEqual([10, 10, 10, 10])
    expect(out[0].startSample).toBe(0)
    const next = m.push('mic', fill(2, 10))
    expect(next).toHaveLength(0) // system lane still short
    expect(m.push('system', fill(2, 5))[0].startSample).toBe(4)
  })

  it('clips the sum to int16', () => {
    const m = new CallLaneMixer({ blockSamples: 2, maxLagSamples: 100, hasSystem: true })
    m.push('mic', fill(2, 30000))
    expect([...m.push('system', fill(2, 30000))[0].mix]).toEqual([32767, 32767])
  })

  it('does not let a stalled system lane hold the mic back', () => {
    const m = new CallLaneMixer({ blockSamples: 4, maxLagSamples: 8, hasSystem: true })
    expect(m.push('mic', fill(8, 1))).toEqual([]) // within the lag budget
    const out = m.push('mic', fill(4, 1)) // 12 queued vs 0: past the budget
    expect(out.length).toBeGreaterThan(0)
    expect([...out[0].mix]).toEqual([1, 1, 1, 1]) // silence filled for the system lane
  })

  it('runs mic-only when system audio is unavailable', () => {
    const m = new CallLaneMixer({ blockSamples: 3, maxLagSamples: 100, hasSystem: false })
    const out = m.push('mic', fill(7, 2))
    expect(out.map((b) => b.startSample)).toEqual([0, 3])
    expect([...out[1].mix]).toEqual([2, 2, 2])
  })
})
