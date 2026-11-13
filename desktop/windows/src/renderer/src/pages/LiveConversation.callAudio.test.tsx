// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureEvent } from '../../../shared/types'

// The whole path a call-audio warning takes in the main window: a capture event
// arrives, LiveMirrorHost applies it to the real live-conversation store, and the
// live view renders the status from that store. Nothing in between is mocked.

vi.mock('../components/recording/LiveNotesPanel', () => ({ LiveNotesPanel: () => null }))
vi.mock('../lib/pendingConversations', () => ({ createPendingConversation: vi.fn() }))
vi.mock('../lib/pageCache', () => ({ refreshCloudConversations: vi.fn() }))
vi.mock('../lib/kgSynthesis', () => ({ buildLocalGraph: vi.fn() }))
vi.mock('../lib/usageLimit', () => ({ maybeTriggerTranscriptionQuotaPopup: vi.fn() }))

import { LiveMirrorHost } from '../components/recording/LiveMirrorHost'
import { liveConversation } from '../lib/liveConversation'
import { LiveConversation } from './LiveConversation'

let handlers: Array<(e: CaptureEvent) => void>
function emit(event: CaptureEvent): void {
  act(() => {
    for (const handler of [...handlers]) handler(event)
  })
}
const lane = (
  system: 'delayed' | 'live' | 'silent' | 'unavailable',
  detail?: string
): CaptureEvent =>
  detail
    ? { type: 'call-audio-status', sessionId: 's1', system, detail }
    : { type: 'call-audio-status', sessionId: 's1', system }
/** The status word, shown in the header and in the badge. */
const shown = (label: string): number => screen.queryAllByText(label).length

beforeEach(() => {
  handlers = []
  liveConversation.reset()
  liveConversation.clearCallAudio()
  ;(window as unknown as { omi: unknown }).omi = {
    captureCommand: vi.fn(),
    onCaptureEvent: (handler: (e: CaptureEvent) => void) => {
      handlers.push(handler)
      return () => (handlers = handlers.filter((h) => h !== handler))
    }
  }
  render(
    <MemoryRouter>
      <LiveMirrorHost />
      <LiveConversation />
    </MemoryRouter>
  )
  emit({ type: 'live', op: { op: 'status', status: 'live' } })
})

afterEach(() => cleanup())

describe('call-audio warning in the live view', () => {
  it('reads Listening while the call session is healthy', () => {
    expect(shown('Listening')).toBe(2)
    emit(lane('live'))
    expect(shown('Listening')).toBe(2)
  })

  it('shows mic only while the loopback is delayed, and clears when it goes live', () => {
    const detail = 'Call audio is not attached yet; recording your microphone only.'
    emit(lane('delayed', detail))
    expect(shown('Listening (mic only)')).toBe(2)
    expect(shown('Listening')).toBe(0)
    expect(screen.getByRole('status').textContent).toBe(detail)

    emit(lane('live'))
    expect(shown('Listening')).toBe(2)
    expect(shown('Listening (mic only)')).toBe(0)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows no call audio while the lane is silent, and clears when it is heard again', () => {
    const detail = 'The monitor of sink is at 8%, so call audio is recorded as silence.'
    emit(lane('silent', detail))
    expect(shown('Listening (no call audio)')).toBe(2)
    expect(screen.getByRole('status').textContent).toBe(detail)

    emit(lane('live'))
    expect(shown('Listening')).toBe(2)
    expect(shown('Listening (no call audio)')).toBe(0)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the warning of a lane that could not be opened until the session ends', () => {
    emit(lane('unavailable', 'Call audio could not be opened (no loopback track).'))
    expect(shown('Listening (mic only)')).toBe(2)
    emit({ type: 'call-audio-status', sessionId: 's1', system: 'off' })
    expect(shown('Listening')).toBe(2)
  })

  it('does not show a lane warning over a session that is not live', () => {
    emit(lane('silent', 'whatever'))
    emit({ type: 'live', op: { op: 'status', status: 'connecting' } })
    expect(shown('Connecting…')).toBe(2)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
