import {
  isCallSystemLaneWarning,
  type CallSystemLaneState,
  type ListenEvent,
  type LiveStoreOp,
  type TranscriptLine
} from '../../../shared/types'

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'error'

/** The system lane of the running 'call' session (the other side of a call), as
 *  last reported by the capture window. Null when no call session is running. */
export type CallAudioState = {
  sessionId: string
  system: Exclude<CallSystemLaneState, 'off'>
  detail: string | null
}

/** The call session's system lane when it is in a state that means the other
 *  side of a call is not being recorded, else null. */
export function callAudioWarning(callAudio: CallAudioState | null): CallAudioState | null {
  return callAudio && isCallSystemLaneWarning(callAudio.system) ? callAudio : null
}

/** The live view's status word. A live session whose call audio is missing must
 *  not read as plain "Listening": that is how a mic-only recording went unnoticed. */
export function liveStatusLabel(
  status: LiveStatus,
  callAudio: CallAudioState | null = null
): string {
  if (status === 'connecting') return 'Connecting…'
  if (status === 'live') {
    const warning = callAudioWarning(callAudio)
    if (!warning) return 'Listening'
    return warning.system === 'silent' ? 'Listening (no call audio)' : 'Listening (mic only)'
  }
  if (status === 'error') return 'Microphone unavailable'
  return 'Idle'
}

// Singleton store for the CURRENT in-progress conversation's live transcript. The
// capture window's mic session writes it (via captureLiveStore, which mirrors each
// mutation to UI windows as a LiveStoreOp); UI windows apply those with
// applyRemoteOp and the LiveConversation view reads the result. Cleared when the
// backend signals a conversation boundary.
let segments: TranscriptLine[] = []
let status: LiveStatus = 'idle'
let errorMsg: string | null = null
// True right after a conversation was finalized/saved: the transcript stays on
// screen (flagged "saved") instead of blanking, and is cleared automatically when
// the next utterance arrives so the view never looks like a jarring new session.
let saved = false
// Title/emoji of the just-finalized conversation, shown in the live view header
// (empty title => "loading…") and filled in by the client-side titler.
let savedTitle = ''
let savedEmoji = ''
// Kept apart from the transcript state above: a call session's lane state follows
// the audio session (call-audio-status events), not the conversation, so neither
// reset() nor a saved conversation clears it.
let callAudio: CallAudioState | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  subscribers.forEach((cb) => cb())
}

export const liveConversation = {
  getSegments(): TranscriptLine[] {
    return segments
  },
  getStatus(): LiveStatus {
    return status
  },
  getError(): string | null {
    return errorMsg
  },
  isSaved(): boolean {
    return saved
  },
  getSavedTopic(): { title: string; emoji: string } {
    return { title: savedTitle, emoji: savedEmoji }
  },
  // Mark the current transcript as saved/finalized but keep it on screen. The next
  // appendLine clears it (the next conversation has started). Title/emoji start
  // empty ("loading…") and are filled by setSavedTopic when the titler resolves.
  markSaved(): void {
    if (segments.length === 0) return
    saved = true
    savedTitle = ''
    savedEmoji = ''
    notify()
  },
  setSavedTopic(title: string, emoji: string): void {
    savedTitle = title
    savedEmoji = emoji
    notify()
  },
  getCallAudio(): CallAudioState | null {
    return callAudio
  },
  // Apply a call-audio-status event. 'off' ends only the session it names, so a
  // late 'off' from the previous session cannot clear its successor's state.
  applyCallAudio(ev: { sessionId: string; system: CallSystemLaneState; detail?: string }): void {
    if (ev.system === 'off') {
      if (callAudio?.sessionId !== ev.sessionId) return
      callAudio = null
    } else {
      callAudio = { sessionId: ev.sessionId, system: ev.system, detail: ev.detail ?? null }
    }
    notify()
  },
  // The capture window restarted: whatever it last reported is gone with it.
  clearCallAudio(): void {
    if (!callAudio) return
    callAudio = null
    notify()
  },
  appendLine(line: TranscriptLine): void {
    // The previous (saved) transcript stays visible until the next utterance —
    // clear it now that a new conversation is starting.
    if (saved) {
      segments = []
      saved = false
      savedTitle = ''
      savedEmoji = ''
    }
    // Upsert by backend segment id when present (segments are re-emitted as they
    // refine around pauses), else append.
    if (line.id) {
      const i = segments.findIndex((s) => s.id === line.id)
      if (i >= 0) {
        segments = segments.map((s, j) => (j === i ? line : s))
        notify()
        return
      }
    }
    segments = [...segments, line]
    notify()
  },
  setStatus(next: LiveStatus, error?: string): void {
    status = next
    // Keep the human-readable cause alongside the 'error' status; clear it on any
    // non-error transition so a recovered session doesn't show a stale message.
    errorMsg = next === 'error' ? (error ?? null) : null
    notify()
  },
  reset(): void {
    segments = []
    status = 'idle'
    errorMsg = null
    saved = false
    savedTitle = ''
    savedEmoji = ''
    notify()
  },
  // Apply a store op broadcast by the capture window (which owns the always-on
  // mic session). UI windows call this to mirror the capture window's store so the
  // LiveConversation view shows the live transcript even though the session runs
  // in another window. Pure w.r.t. the module store — no IPC, so it's unit-tested.
  applyRemoteOp(op: LiveStoreOp): void {
    switch (op.op) {
      case 'reset':
        this.reset()
        break
      case 'status':
        this.setStatus(op.status, op.error)
        break
      case 'append':
        this.appendLine(op.line)
        break
      case 'saved':
        // Snap the mirror to exactly the saved segments, flagged "saved" (title/
        // emoji fill in when the UI window's titler resolves via setSavedTopic).
        segments = op.segments
        saved = true
        savedTitle = ''
        savedEmoji = ''
        notify()
        break
    }
  },
  subscribe(cb: () => void): () => void {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }
}

// The backend emits `memory_creating` when it has decided the current
// conversation ended and is being turned into a memory. That's our cue to clear
// the live transcript and refresh the cloud conversation list. (Quota events are
// handled inside transcriptionClient, not here.)
export function isConversationBoundary(event: ListenEvent): boolean {
  return event.type === 'memory_creating'
}

// "Save now": a user-driven request to finalize the current conversation
// immediately (instead of waiting for the backend's silence boundary). Whoever
// owns the active mic session — the always-on host or the one-off live view —
// subscribes and responds by ending its session (which makes the backend store
// the conversation) and starting a fresh one.
const finalizeSubscribers = new Set<() => void>()

export function onFinalizeRequest(cb: () => void): () => void {
  finalizeSubscribers.add(cb)
  return () => {
    finalizeSubscribers.delete(cb)
  }
}

// The capture window (renderer #/capture) owns the always-on mic session and its
// finalize subscriber; every UI window just forwards the request to it.
function isCaptureWindow(): boolean {
  return typeof window !== 'undefined' && window.location?.hash?.startsWith('#/capture')
}

export function requestFinalize(): void {
  // In a UI window the session lives in the capture window — send the command
  // (main forwards it). In the capture window, notify the local subscriber (the
  // running liveMicSession) directly.
  if (!isCaptureWindow() && typeof window !== 'undefined' && window.omi?.captureCommand) {
    window.omi.captureCommand({ type: 'live-finalize' })
    return
  }
  finalizeSubscribers.forEach((cb) => cb())
}
