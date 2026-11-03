// Collects the segments main attributed to the user (client_attribution 'self')
// in the current server conversation, so they can be saved as is_user with one
// PATCH /v1/conversations/{id}/segments/assign-bulk once that conversation is
// over. The backend learns the user's voice from the assignment.
import type { BackendSegment } from '../../../shared/types'

export type SelfAssignmentBatch = { conversationId: string; segmentIds: string[] }

export type SelfAssignmentTracker = {
  /** The socket announced a conversation. Returns the previous conversation's
   *  batch when the id changed (that conversation is over), else null. */
  noteConversation: (conversationId: string) => SelfAssignmentBatch | null
  noteSegments: (segments: BackendSegment[]) => void
  noteDeleted: (segmentIds: string[]) => void
  /** The current conversation's batch (null when empty); clears it. */
  drain: () => SelfAssignmentBatch | null
}

export function createSelfAssignmentTracker(): SelfAssignmentTracker {
  let conversationId: string | null = null
  let selfIds = new Set<string>()

  const take = (): SelfAssignmentBatch | null => {
    const batch =
      conversationId !== null && selfIds.size > 0
        ? { conversationId, segmentIds: [...selfIds] }
        : null
    selfIds = new Set()
    return batch
  }

  return {
    noteConversation: (id) => {
      if (id === conversationId) return null
      const previous = take()
      conversationId = id
      return previous
    },
    noteSegments: (segments) => {
      for (const seg of segments) {
        if (!seg.id) continue
        // Live segments are rewritten as they grow; follow the latest verdict.
        if (seg.client_attribution === 'self') selfIds.add(seg.id)
        else if (seg.client_attribution === 'other') selfIds.delete(seg.id)
      }
    },
    noteDeleted: (ids) => {
      for (const id of ids) selfIds.delete(id)
    },
    drain: take
  }
}
