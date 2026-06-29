// Shared voice-activity-detection (VAD) helper.
//
// Both the microphone path (`useSpeech.ts`) and the system-audio path
// (`useSystemAudio.ts`) use this module to slice audio at natural speech
// pauses instead of hard-cutting on a fixed timer. A Web Audio `AnalyserNode`
// samples the RMS volume every `sampleIntervalMs`; once speech has been heard
// for at least `minChunkDuration` and is then followed by `silenceTimeout` of
// silence, the current chunk is cut. `maxChunkDuration` is a safety ceiling so
// long continuous speech still gets flushed.

export interface VadParams {
	/** Volume amplitude threshold; below this counts as silence (ignores room background noise). */
	silenceThreshold: number
	/** Silence duration in ms required to trigger a sentence boundary. */
	silenceTimeout: number
	/** Minimum slice duration in ms before a pause may cut a chunk (keeps phrases coherent). */
	minChunkDuration: number
	/** Safety ceiling in ms for long continuous speech. */
	maxChunkDuration: number
	/** How often the RMS volume is sampled, in ms. */
	sampleIntervalMs: number
}

export const DEFAULT_VAD_PARAMS: VadParams = {
	silenceThreshold: 0.015,
	silenceTimeout: 1000,
	minChunkDuration: 2000,
	maxChunkDuration: 8000,
	sampleIntervalMs: 100,
}

/** Mutable state carried across VAD samples for a single in-flight chunk. */
export interface VadState {
	/** Whether any speech (rms above threshold) has been observed yet. */
	hasSpeechStarted: boolean
	/** Timestamp (ms) of the most recent above-threshold sample. */
	lastSpeechTime: number
	/** Timestamp (ms) when the current chunk started recording. */
	startTime: number
}

export interface VadEvaluation {
	/** True when the current chunk should be cut at this sample. */
	cut: boolean
	/** Updated VAD state to carry into the next sample. */
	state: VadState
}

/** Root-mean-square amplitude of a time-domain sample buffer. */
export function computeRms(dataArray: Float32Array, length = dataArray.length): number {
	if (length <= 0) return 0
	let sum = 0
	for (let i = 0; i < length; i++) {
		sum += dataArray[i] * dataArray[i]
	}
	return Math.sqrt(sum / length)
}

/**
 * Pure VAD state machine evaluated once per sample. Returns whether the chunk
 * should be cut and the next state. Kept side-effect-free so it can be unit
 * tested without the DOM / Web Audio APIs.
 */
export function evaluateVad(
	state: VadState,
	now: number,
	rms: number,
	params: VadParams
): VadEvaluation {
	const duration = now - state.startTime

	// Safety ceiling: flush long continuous speech regardless of pauses.
	if (duration >= params.maxChunkDuration) {
		return { cut: true, state }
	}

	if (rms > params.silenceThreshold) {
		return { cut: false, state: { ...state, hasSpeechStarted: true, lastSpeechTime: now } }
	}

	// Silence: only cut once we've heard real speech and met the minimum length.
	if (state.hasSpeechStarted && duration >= params.minChunkDuration) {
		if (now - state.lastSpeechTime >= params.silenceTimeout) {
			return { cut: true, state }
		}
	}

	return { cut: false, state }
}

export interface VadRecordingOptions {
	/** Audio stream to record. */
	stream: MediaStream
	/** Analyser fed from the same stream, used to sample volume. */
	analyser: AnalyserNode
	/** Returns false once recording should stop (e.g. the hook is no longer active). */
	isActive(): boolean
	/** Called with each completed WebM chunk. */
	onChunk(blob: Blob): void | Promise<void>
	/** Optional overrides for the default VAD tuning. */
	params?: Partial<VadParams>
}

export interface VadRecordingHandle {
	/** Stop the rolling recorder; flushes the in-flight chunk and stops recursing. */
	stop(): void
}

/**
 * Build an `AnalyserNode` wired to a stream for VAD sampling, matching the
 * settings both audio paths use.
 */
export function createVadAnalyser(audioContext: AudioContext, stream: MediaStream): AnalyserNode {
	const source = audioContext.createMediaStreamSource(stream)
	const analyser = audioContext.createAnalyser()
	analyser.fftSize = 512
	source.connect(analyser)
	return analyser
}

/**
 * Roll a `MediaRecorder` over a stream, cutting chunks at natural speech pauses
 * via {@link evaluateVad}. Each completed chunk is a self-contained WebM file so
 * Whisper can decode it. The recorder restarts after every cut until `stop()` is
 * called or `isActive()` returns false.
 */
export function startVadRecording(opts: VadRecordingOptions): VadRecordingHandle {
	const params: VadParams = { ...DEFAULT_VAD_PARAMS, ...opts.params }
	let stopped = false
	let intervalId: number | null = null
	let currentRecorder: MediaRecorder | null = null

	const clearTimer = () => {
		if (intervalId !== null) {
			window.clearInterval(intervalId)
			intervalId = null
		}
	}

	const recordOnce = () => {
		if (stopped || !opts.isActive()) return

		const recorder = new MediaRecorder(opts.stream)
		currentRecorder = recorder
		const parts: BlobPart[] = []

		let vadState: VadState = {
			hasSpeechStarted: false,
			lastSpeechTime: Date.now(),
			startTime: Date.now(),
		}

		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) parts.push(e.data)
		}
		recorder.onstop = async () => {
			clearTimer()
			const blob = new Blob(parts, { type: recorder.mimeType })
			await opts.onChunk(blob)
			if (!stopped && opts.isActive()) recordOnce()
		}
		recorder.start()

		const bufferLength = opts.analyser.frequencyBinCount
		const dataArray = new Float32Array(bufferLength)

		intervalId = window.setInterval(() => {
			if (stopped || !opts.isActive() || recorder.state !== 'recording') {
				clearTimer()
				return
			}

			opts.analyser.getFloatTimeDomainData(dataArray)
			const rms = computeRms(dataArray, bufferLength)
			const result = evaluateVad(vadState, Date.now(), rms, params)
			vadState = result.state
			if (result.cut) recorder.stop()
		}, params.sampleIntervalMs)
	}

	recordOnce()

	return {
		stop() {
			stopped = true
			clearTimer()
			// Stopping the recorder flushes the in-flight chunk via onstop; the
			// `stopped` flag prevents it from recursing into a new recording.
			if (currentRecorder && currentRecorder.state !== 'inactive') {
				currentRecorder.stop()
			}
		},
	}
}
