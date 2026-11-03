import { useEffect } from 'react'
import {
  createPcmPipeline,
  createVadGate,
  type PcmPipeline,
  type VadGate
} from '../lib/capture/captureEngine'
import { resolveVadGateMode } from '../lib/capture/vadGate'
import { getPreferences } from '../lib/preferences'
import { getSystemAudioStream } from '../lib/capture/systemAudio'
import {
  createLoopbackMusicFilter,
  type LoopbackMusicFilter
} from '../lib/capture/loopbackMusicFilter'
import { acquireMicStream } from '../lib/audio'
import { assistantGate, wrapFeed } from './assistantGate'
import {
  LISTEN_CALL_CHANNEL,
  type ListenCallChannel,
  type ListenSource
} from '../../../shared/types'

// The capture window's continuous-audio engine. Serves audio-start / audio-stop
// commands (from the capture window's own continuous-mic lane and from UI screen
// sessions): acquires the source stream, runs it through the PCM pipeline and the
// VAD gate, and forwards gated PCM to the main-process WebSocket via
// window.omi.listenFeed(sessionId, chunk). The main process routes transcript
// messages back to whichever window opened the listen session (its ownerId), so
// audio origin (here) and transcript destination decouple.
//
// Module-singleton session map keyed by sessionId so the command server is
// idempotent under React StrictMode double-mount / duplicate commands; the
// component only owns the command subscription.

type AudioSession = {
  ownerId: number
  pipeline: PcmPipeline | null
  gate: VadGate | null
  // Loopback lane only: YAMNet speech/music filter between the VAD gate and the
  // WebSocket feed (a confident music verdict drops the audio).
  musicFilter: LoopbackMusicFilter | null
  // 'call' sessions only: the system-audio lane's pipeline (the mic lane uses
  // `pipeline`).
  systemPipeline: PcmPipeline | null
  // Set if audio-stop lands while the source stream is still being acquired, so
  // the resolved stream is torn down instead of leaking.
  stopped: boolean
}

const sessions = new Map<string, AudioSession>()

async function startAudioSession(
  sessionId: string,
  source: ListenSource,
  ownerId: number
): Promise<void> {
  if (sessions.has(sessionId)) return // idempotent — duplicate/StrictMode command
  const session: AudioSession = {
    ownerId,
    pipeline: null,
    gate: null,
    musicFilter: null,
    systemPipeline: null,
    stopped: false
  }
  sessions.set(sessionId, session)
  if (source === 'call') {
    await startCallAudio(sessionId, session, ownerId)
    return
  }

  let stream: MediaStream
  try {
    stream = source === 'mic' ? await acquireMicStream() : await getSystemAudioStream()
  } catch (e) {
    sessions.delete(sessionId)
    const err = e as Error
    // Route the source failure back to the window that opened the session so it
    // can surface a mic/loopback error (same shape omiListenClient expects).
    window.omi?.captureEmit(
      { type: 'audio-source-error', sessionId, name: err.name, message: err.message },
      ownerId
    )
    return
  }

  // audio-stop arrived while acquiring — drop the just-opened stream.
  if (session.stopped) {
    stream.getTracks().forEach((t) => t.stop())
    sessions.delete(sessionId)
    return
  }

  try {
    const feed = (pcm: Int16Array): void =>
      window.omi?.listenFeed(sessionId, pcm.buffer as ArrayBuffer)
    // Loopback lane: classify VAD-gated windows (YAMNet) so a confident music
    // verdict closes the lane — ambient/meeting capture never transcribes a
    // movie. The mic lane never classifies (the user's own voice always counts).
    let onVoiced = feed
    if (source !== 'mic') {
      const filter = createLoopbackMusicFilter(feed)
      session.musicFilter = filter
      onVoiced = filter.push
    }
    // Read the local-VAD-gate preference at session start (Settings → Transcription).
    // Disabled → passthrough, so every frame reaches the backend ungated.
    const gate = createVadGate({
      onVoiced,
      mode: resolveVadGateMode(getPreferences().vadGateEnabled)
    })
    session.gate = gate
    // Echo gate (Phase 6): while Omi's voice plays, drop frames BEFORE the VAD
    // gate so Omi's speech never enters the pre-roll ring either. Applies to both
    // lanes — mic (acoustic echo) and system audio (Omi's voice IS system output).
    session.pipeline = createPcmPipeline(
      stream,
      wrapFeed((pcm) => gate.push(pcm))
    )
  } catch (e) {
    session.pipeline?.stop()
    if (!session.pipeline) stream.getTracks().forEach((t) => t.stop())
    session.gate?.stop()
    session.musicFilter?.stop()
    sessions.delete(sessionId)
    const err = e instanceof Error ? e : new Error(String(e))
    window.omi?.captureEmit(
      { type: 'audio-source-error', sessionId, name: err.name, message: err.message },
      ownerId
    )
    return
  }

  const setup = await session.pipeline.ready
  if (session.stopped) return
  if (!setup.ok) {
    session.pipeline.stop()
    session.gate?.stop()
    session.musicFilter?.stop()
    sessions.delete(sessionId)
    window.omi?.captureEmit(
      {
        type: 'audio-source-error',
        sessionId,
        name: setup.error.name,
        message: setup.error.message
      },
      ownerId
    )
    return
  }
  window.omi?.captureEmit({ type: 'audio-source-ready', sessionId }, ownerId)
}

/**
 * 'call': the mic (channel 0x01, the user) and the system loopback (0x02, the
 * other side of a call) feed ONE two-channel listen socket. Both lanes stream
 * ungated (no VAD gate, no music filter): the backend pairs the channels' audio
 * by length, so a lane that goes quiet must keep sending its silence. If system
 * audio can't be opened the session still runs with the mic, and channel 0x02 is
 * fed matching silence so the pairing stays aligned. The echo gate still applies
 * to both lanes.
 */
async function startCallAudio(
  sessionId: string,
  session: AudioSession,
  ownerId: number
): Promise<void> {
  const fail = (e: unknown): void => {
    session.pipeline?.stop()
    session.systemPipeline?.stop()
    sessions.delete(sessionId)
    const err = e instanceof Error ? e : new Error(String(e))
    window.omi?.captureEmit(
      { type: 'audio-source-error', sessionId, name: err.name, message: err.message },
      ownerId
    )
  }

  let mic: MediaStream
  try {
    mic = await acquireMicStream()
  } catch (e) {
    fail(e)
    return
  }
  let system: MediaStream | null = null
  try {
    system = await getSystemAudioStream()
  } catch (e) {
    console.warn('[call-capture] system audio unavailable; mic only:', (e as Error).message)
  }
  if (session.stopped) {
    mic.getTracks().forEach((t) => t.stop())
    system?.getTracks().forEach((t) => t.stop())
    sessions.delete(sessionId)
    return
  }

  const feedOn =
    (channel: ListenCallChannel) =>
    (pcm: Int16Array): void =>
      window.omi?.listenFeed(sessionId, pcm.buffer as ArrayBuffer, channel)
  const micFeed = feedOn(LISTEN_CALL_CHANNEL.mic)
  const systemFeed = feedOn(LISTEN_CALL_CHANNEL.system)
  try {
    session.pipeline = createPcmPipeline(
      mic,
      wrapFeed(
        system
          ? micFeed
          : (pcm) => {
              micFeed(pcm)
              systemFeed(new Int16Array(pcm.length))
            }
      )
    )
    if (system) session.systemPipeline = createPcmPipeline(system, wrapFeed(systemFeed))
  } catch (e) {
    if (!session.pipeline) mic.getTracks().forEach((t) => t.stop())
    if (!session.systemPipeline) system?.getTracks().forEach((t) => t.stop())
    fail(e)
    return
  }

  const setups = await Promise.all([
    session.pipeline.ready,
    session.systemPipeline?.ready ?? Promise.resolve({ ok: true as const })
  ])
  if (session.stopped) return
  const failed = setups.find((r) => !r.ok)
  if (failed && !failed.ok) {
    fail(failed.error)
    return
  }
  window.omi?.captureEmit({ type: 'audio-source-ready', sessionId }, ownerId)
}

/** Test-only (read via the OMI_E2E-gated capture hook): current music-gate
 *  verdict of each active loopback session. Empty when no loopback lane runs. */
export function _loopbackVerdictsForTest(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, s] of sessions) {
    if (s.musicFilter) out[id] = s.musicFilter.verdict()
  }
  return out
}

function stopAudioSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.stopped = true
  s.pipeline?.stop() // tears down the graph and stops the stream tracks
  s.systemPipeline?.stop()
  s.gate?.stop()
  s.musicFilter?.stop()
  sessions.delete(sessionId)
}

/** Mounted once in CaptureApp. Only owns the command subscription; all session
 *  state lives in the module singleton above. */
export function AudioSessionHost(): null {
  useEffect(() => {
    return window.omi?.onCaptureCommand?.((cmd, ownerId) => {
      if (cmd.type === 'audio-start') {
        void startAudioSession(cmd.sessionId, cmd.source, ownerId)
      } else if (cmd.type === 'audio-stop') {
        stopAudioSession(cmd.sessionId)
      } else if (cmd.type === 'assistant-speaking') {
        // Echo gate: the voice surface owns the timing (incl. the release
        // hangover); this window just enforces the final boolean on all
        // continuous feeds via wrapFeed above.
        assistantGate.setSpeaking(cmd.active)
      }
    })
  }, [])
  return null
}
