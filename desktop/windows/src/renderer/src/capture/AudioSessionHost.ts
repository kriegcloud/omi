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
  CALL_UPSTREAM_CHANNELS,
  LISTEN_CALL_CHANNEL,
  type CallSystemLaneState,
  type ListenCallChannel,
  type ListenSource
} from '../../../shared/types'
import { CallLaneMixer, type MixedBlock } from '../lib/capture/callMixer'
import { createSelfSpeechTracker, type SelfSpeechTracker } from './selfSpeech'
import { createSystemLaneWatch, type SystemLaneWatch } from './systemLaneWatch'

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
  // 'call' sessions on a mono upstream: reports the mic lane's own speech.
  selfSpeech: SelfSpeechTracker | null
  // 'call' sessions only: watches the attached system lane for sustained silence.
  systemWatch: SystemLaneWatch | null
  // A 'call' session reports its system lane's state (call-audio-status).
  isCall: boolean
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
    selfSpeech: null,
    systemWatch: null,
    isCall: source === 'call',
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

// A loopback that is still not open after this long is reported as 'delayed'.
export const CALL_SYSTEM_LANE_DELAYED_MS = 5_000
// Waits before the second and third attempt at a loopback that failed to open.
export const CALL_SYSTEM_LANE_RETRY_MS: readonly number[] = [5_000, 15_000]

function emitCallAudio(sessionId: string, system: CallSystemLaneState, detail?: string): void {
  window.omi?.captureEmit(
    detail
      ? { type: 'call-audio-status', sessionId, system, detail }
      : { type: 'call-audio-status', sessionId, system }
  )
}

/** Stop everything a session holds and forget it. `stopped` also releases a
 *  source that is still being acquired once it resolves. */
function teardownSession(sessionId: string, s: AudioSession): void {
  s.stopped = true
  s.pipeline?.stop() // tears down the graph and stops the stream tracks
  s.systemPipeline?.stop()
  s.systemWatch?.stop()
  s.selfSpeech?.stop()
  s.gate?.stop()
  s.musicFilter?.stop()
  sessions.delete(sessionId)
  if (s.isCall) emitCallAudio(sessionId, 'off')
}

/**
 * 'call': the mic and the system loopback (the other side of a call) feed ONE
 * listen socket, ungated so the backend's offsets track wall time.
 *  - Mono upstream (CALL_UPSTREAM_CHANNELS = 1): CallLaneMixer sums the lanes in
 *    aligned blocks; the mic samples of each block go to a self-speech tracker
 *    that reports the user's own speech as fed-stream sample positions
 *    (listenActivity), so main can mark the user's segments.
 *  - Two-channel upstream: each lane feeds its own channel id instead.
 * The session is ready as soon as the mic lane is: the loopback is opened beside
 * it and joins the stream when it resolves (openSystemLane). Waiting for it used
 * to hold `audio-source-ready` back, and on a loaded machine the display-media
 * request took longer than the connect timeout, so the session was torn down and
 * restarted every 10 s without ever recording (2026-11-12). Until the loopback is
 * up, and if it never comes up, the session runs on the mic. While Omi's own
 * voice plays (echo gate) the mono feed carries silence rather than dropping
 * frames, so sample positions stay aligned with what the backend receives.
 */
async function startCallAudio(
  sessionId: string,
  session: AudioSession,
  ownerId: number
): Promise<void> {
  const fail = (e: unknown): void => {
    teardownSession(sessionId, session)
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
  if (session.stopped) {
    mic.getTracks().forEach((t) => t.stop())
    sessions.delete(sessionId)
    return
  }

  let micInput: (pcm: Int16Array) => void
  let systemInput: (pcm: Int16Array) => void
  let attachSystem: () => void
  if (CALL_UPSTREAM_CHANNELS === 1) {
    const selfSpeech = createSelfSpeechTracker((speaking, atSample) =>
      window.omi?.listenActivity?.(sessionId, { lane: 'mic', speaking, atSample })
    )
    session.selfSpeech = selfSpeech
    const mixer = new CallLaneMixer({
      blockSamples: 1600, // 100 ms
      maxLagSamples: 8000, // 0.5 s before a stalled lane is filled with silence
      hasSystem: false // mic only until the loopback is up
    })
    const emit = (blocks: MixedBlock[]): void => {
      for (const b of blocks) {
        const out = assistantGate.isPaused() ? new Int16Array(b.mix.length) : b.mix
        window.omi?.listenFeed(sessionId, out.buffer as ArrayBuffer)
        selfSpeech.push(b.mic)
      }
    }
    micInput = (pcm) => emit(mixer.push('mic', pcm))
    systemInput = (pcm) => emit(mixer.push('system', pcm))
    attachSystem = () => mixer.attachSystem()
  } else {
    const feedOn =
      (channel: ListenCallChannel) =>
      (pcm: Int16Array): void =>
        window.omi?.listenFeed(sessionId, pcm.buffer as ArrayBuffer, channel)
    const micFeed = wrapFeed(feedOn(LISTEN_CALL_CHANNEL.mic))
    const systemFeed = wrapFeed(feedOn(LISTEN_CALL_CHANNEL.system))
    let attached = false
    // The system channel carries silence until its lane is up.
    micInput = (pcm) => {
      micFeed(pcm)
      if (!attached) systemFeed(new Int16Array(pcm.length))
    }
    systemInput = (pcm) => {
      if (attached) systemFeed(pcm)
    }
    attachSystem = () => {
      attached = true
    }
  }
  try {
    session.pipeline = createPcmPipeline(mic, micInput)
  } catch (e) {
    mic.getTracks().forEach((t) => t.stop())
    fail(e)
    return
  }

  void openSystemLane(sessionId, session, systemInput, attachSystem)

  const setup = await session.pipeline.ready
  if (session.stopped) return
  if (!setup.ok) {
    fail(setup.error)
    return
  }
  window.omi?.captureEmit({ type: 'audio-source-ready', sessionId }, ownerId)
}

/** One attempt at the loopback. Resolves null once the lane is mixed in (or the
 *  session ended meanwhile), else the reason it could not be opened. */
async function tryOpenSystemLane(
  session: AudioSession,
  systemInput: (pcm: Int16Array) => void,
  attachSystem: () => void,
  onWatchState: (state: 'silent' | 'live', detail?: string) => void
): Promise<Error | null> {
  let system: MediaStream
  try {
    system = await getSystemAudioStream()
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
  // audio-stop arrived while the request was pending: drop the stream.
  if (session.stopped) {
    system.getTracks().forEach((t) => t.stop())
    return null
  }
  let pipeline: PcmPipeline
  try {
    pipeline = createPcmPipeline(system, (pcm) => {
      session.systemWatch?.push(pcm)
      systemInput(pcm)
    })
  } catch (e) {
    system.getTracks().forEach((t) => t.stop())
    return e instanceof Error ? e : new Error(String(e))
  }
  session.systemPipeline = pipeline
  const setup = await pipeline.ready
  if (session.stopped) return null // teardownSession stopped the pipeline
  if (!setup.ok) {
    pipeline.stop()
    session.systemPipeline = null
    return setup.error
  }
  session.systemWatch = createSystemLaneWatch({
    probe: () => window.omi?.systemPlaybackProbe?.() ?? Promise.resolve({ supported: false }),
    onState: onWatchState
  })
  attachSystem()
  return null
}

/**
 * Open a 'call' session's system lane beside the running mic lane and report
 * where it stands (call-audio-status), so a session that is recording the mic
 * only never looks the same as one that hears the call. A request that is merely
 * slow is waited for, however long it takes; one that fails is retried twice.
 */
async function openSystemLane(
  sessionId: string,
  session: AudioSession,
  systemInput: (pcm: Int16Array) => void,
  attachSystem: () => void
): Promise<void> {
  const report = (state: CallSystemLaneState, detail?: string): void => {
    if (!session.stopped) emitCallAudio(sessionId, state, detail)
  }
  report('opening')
  for (let attempt = 0; ; attempt++) {
    const slow = setTimeout(
      () => report('delayed', 'Call audio is not attached yet; recording your microphone only.'),
      CALL_SYSTEM_LANE_DELAYED_MS
    )
    const error = await tryOpenSystemLane(session, systemInput, attachSystem, report)
    clearTimeout(slow)
    if (session.stopped) return
    if (!error) {
      report('live')
      return
    }
    console.warn('[call-capture] system audio unavailable; mic only:', error.message)
    const retryIn = CALL_SYSTEM_LANE_RETRY_MS[attempt]
    report(
      'unavailable',
      `Call audio could not be opened (${error.message}); recording your microphone only.`
    )
    if (retryIn === undefined) return
    await new Promise((resolve) => setTimeout(resolve, retryIn))
    if (session.stopped) return
  }
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
  if (s) teardownSession(sessionId, s)
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
