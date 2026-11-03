import { describe, expect, it } from 'vitest'
import { createSelfAssignmentTracker } from './selfAssignment'
import type { BackendSegment } from '../../../shared/types'

const seg = (id: string, client_attribution?: 'self' | 'other'): BackendSegment => ({
  id,
  text: id,
  is_user: client_attribution === 'self',
  start: 0,
  end: 1,
  client_attribution
})

describe('createSelfAssignmentTracker', () => {
  it('hands over the finished conversation when the id changes', () => {
    const t = createSelfAssignmentTracker()
    expect(t.noteConversation('c1')).toBeNull()
    t.noteSegments([seg('a', 'self'), seg('b', 'other'), seg('c')])
    expect(t.noteConversation('c1')).toBeNull() // same conversation re-announced
    expect(t.noteConversation('c2')).toEqual({ conversationId: 'c1', segmentIds: ['a'] })
    expect(t.drain()).toBeNull()
  })

  it('follows re-attribution and deletions of live segments', () => {
    const t = createSelfAssignmentTracker()
    t.noteConversation('c1')
    t.noteSegments([seg('a', 'self'), seg('b', 'self'), seg('d', 'self')])
    t.noteSegments([seg('b', 'other')])
    t.noteDeleted(['d'])
    expect(t.drain()).toEqual({ conversationId: 'c1', segmentIds: ['a'] })
  })

  it('has nothing to save before a conversation is known', () => {
    const t = createSelfAssignmentTracker()
    t.noteSegments([seg('a', 'self')])
    expect(t.drain()).toBeNull()
  })
})
