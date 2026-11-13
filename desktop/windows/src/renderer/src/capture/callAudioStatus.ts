// The capture window's record of where each call session's system lane stands.
// Every report goes out as a call-audio-status event (main window + main's log)
// and is remembered here, because a UI window only ever hears changes: one that
// loads or reloads mid-call would otherwise show plain "Listening" over a lane
// that went silent or unavailable minutes ago and has nothing new to say. Such a
// window sends call-audio-sync and gets the current states again (replayCallAudio).
import type { CallSystemLaneState } from '../../../shared/types'

type Current = { system: Exclude<CallSystemLaneState, 'off'>; detail?: string }

// Insertion-ordered, with a re-report moved to the end, so a replay ends on the
// most recent report: the UI keeps one state, the last it was told.
const current = new Map<string, Current>()

function emit(sessionId: string, system: CallSystemLaneState, detail?: string): void {
  window.omi?.captureEmit?.(
    detail
      ? { type: 'call-audio-status', sessionId, system, detail }
      : { type: 'call-audio-status', sessionId, system }
  )
}

/** Report a system-lane state. `sessionId` is the listen session's id, or any
 *  stable id for a state that belongs to no audio session (the mic fallback after
 *  the backend refuses call capture). 'off' ends it. */
export function reportCallAudio(
  sessionId: string,
  system: CallSystemLaneState,
  detail?: string
): void {
  current.delete(sessionId)
  if (system !== 'off') current.set(sessionId, detail ? { system, detail } : { system })
  emit(sessionId, system, detail)
}

/** Send every current state again, oldest report first. */
export function replayCallAudio(): void {
  for (const [sessionId, state] of current) emit(sessionId, state.system, state.detail)
}

/** Test-only: forget everything without emitting. */
export function _resetCallAudioForTest(): void {
  current.clear()
}
