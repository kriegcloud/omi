// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveConversation } from '../../../lib/liveConversation'
import { setPreferences } from '../../../lib/preferences'
import { HubHeader } from './HubHeader'

// The Listening pill while a call session is missing its call audio: amber and
// explained, with the change announced through a polite live region.

const DETAIL = 'The monitor of sink is at 8%, so call audio is recorded as silence.'

beforeEach(() => {
  liveConversation.reset()
  liveConversation.clearCallAudio()
  setPreferences({ continuousRecording: true })
  ;(window as unknown as { omi: unknown }).omi = {
    rewindGetSettings: async () => ({ captureEnabled: false }),
    rewindSetSettings: vi.fn(async (s: unknown) => s),
    onRewindSettings: () => () => {}
  }
  render(
    <MemoryRouter>
      <HubHeader />
    </MemoryRouter>
  )
})

afterEach(() => cleanup())

const pill = (): HTMLElement => screen.getByRole('button', { name: 'Stop listening' })
const liveRegion = (): Element => {
  const region = document.querySelector('[aria-live="polite"]')
  if (!region) throw new Error('no polite live region')
  return region
}
const announced = (): string => liveRegion().textContent ?? ''

describe('HubHeader listening pill', () => {
  it('is plain while listening is healthy', () => {
    act(() => liveConversation.setStatus('live'))
    expect(pill().getAttribute('title')).toBeNull()
    expect(announced()).toBe('')
  })

  it('announces a missing-call-audio warning and keeps the label as the action', () => {
    act(() => {
      liveConversation.setStatus('live')
      liveConversation.applyCallAudio({ sessionId: 's1', system: 'silent', detail: DETAIL })
    })
    // Same accessible name as before: the label is what the button does.
    expect(pill().getAttribute('title')).toBe(DETAIL)
    expect(announced()).toBe(DETAIL)
    // Polite, never assertive, and not a second role="status" on this screen.
    expect(liveRegion().getAttribute('aria-atomic')).toBe('true')
    expect(liveRegion().getAttribute('role')).toBeNull()
  })

  it('clears the announcement when the call is heard again', () => {
    act(() => {
      liveConversation.setStatus('live')
      liveConversation.applyCallAudio({ sessionId: 's1', system: 'silent', detail: DETAIL })
    })
    act(() => liveConversation.applyCallAudio({ sessionId: 's1', system: 'live' }))
    expect(announced()).toBe('')
    expect(pill().getAttribute('title')).toBeNull()
  })

  it('does not warn while the session is not live', () => {
    act(() => {
      liveConversation.setStatus('connecting')
      liveConversation.applyCallAudio({ sessionId: 's1', system: 'unavailable', detail: DETAIL })
    })
    expect(announced()).toBe('')
  })

  it('says nothing once listening is switched off', () => {
    act(() => {
      liveConversation.setStatus('live')
      liveConversation.applyCallAudio({ sessionId: 's1', system: 'silent', detail: DETAIL })
    })
    act(() => setPreferences({ continuousRecording: false }))
    expect(screen.getByRole('button', { name: 'Start listening' }).getAttribute('title')).toBeNull()
    expect(announced()).toBe('')
  })
})
