import { describe, expect, it } from 'vitest'
import { computeRms, evaluateVad, DEFAULT_VAD_PARAMS, type VadState } from '../client/vad'

// ── computeRms ────────────────────────────────────────────────────────────────

describe('computeRms', () => {
	it('returns 0 for an empty/zero-length array', () => {
		expect(computeRms(new Float32Array(0))).toBe(0)
		expect(computeRms(new Float32Array([1, 2, 3]), 0)).toBe(0)
	})

	it('returns 0 for an all-zero buffer', () => {
		expect(computeRms(new Float32Array([0, 0, 0]))).toBe(0)
	})

	it('computes correct RMS for uniform signal', () => {
		// RMS of [1, 1, 1, 1] is sqrt(4/4) = 1
		const arr = new Float32Array([1, 1, 1, 1])
		expect(computeRms(arr)).toBeCloseTo(1, 5)
	})

	it('computes correct RMS for known mixed values', () => {
		// RMS of [0, 1, 0, -1] = sqrt((0+1+0+1)/4) = sqrt(0.5) ≈ 0.7071
		const arr = new Float32Array([0, 1, 0, -1])
		expect(computeRms(arr)).toBeCloseTo(Math.sqrt(0.5), 5)
	})

	it('respects the length parameter', () => {
		// Only first 2 elements: [1, 1] → RMS = 1
		const arr = new Float32Array([1, 1, 0, 0])
		expect(computeRms(arr, 2)).toBeCloseTo(1, 5)
	})
})

// ── evaluateVad ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<VadState> = {}): VadState {
	return {
		hasSpeechStarted: false,
		lastSpeechTime: 0,
		startTime: 0,
		...overrides,
	}
}

describe('evaluateVad', () => {
	const params = DEFAULT_VAD_PARAMS
	const { silenceThreshold, silenceTimeout, minChunkDuration, maxChunkDuration } = params

	it('cuts immediately when maxChunkDuration is reached', () => {
		const state = makeState({ startTime: 0 })
		const result = evaluateVad(state, maxChunkDuration, 0, params)
		expect(result.cut).toBe(true)
	})

	it('does not cut before maxChunkDuration when speech is present', () => {
		const state = makeState({ startTime: 0 })
		const result = evaluateVad(state, maxChunkDuration - 1, silenceThreshold + 0.1, params)
		expect(result.cut).toBe(false)
	})

	it('marks hasSpeechStarted when rms exceeds threshold', () => {
		const state = makeState({ startTime: 0 })
		const result = evaluateVad(state, 100, silenceThreshold + 0.1, params)
		expect(result.cut).toBe(false)
		expect(result.state.hasSpeechStarted).toBe(true)
	})

	it('updates lastSpeechTime on speech', () => {
		const state = makeState({ startTime: 0, hasSpeechStarted: false })
		const result = evaluateVad(state, 500, silenceThreshold + 0.1, params)
		expect(result.state.lastSpeechTime).toBe(500)
	})

	it('does not cut on silence before speech has started', () => {
		// No speech detected yet
		const state = makeState({ startTime: 0, hasSpeechStarted: false, lastSpeechTime: 0 })
		const now = minChunkDuration + silenceTimeout + 1
		const result = evaluateVad(state, now, 0, params)
		expect(result.cut).toBe(false)
	})

	it('does not cut on silence before minChunkDuration even after speech', () => {
		const state = makeState({
			startTime: 0,
			hasSpeechStarted: true,
			lastSpeechTime: 0,
		})
		const now = minChunkDuration - 1
		const result = evaluateVad(state, now, 0, params)
		expect(result.cut).toBe(false)
	})

	it('cuts on silence after minChunkDuration and silenceTimeout', () => {
		const speechEndTime = 500
		const state = makeState({
			startTime: 0,
			hasSpeechStarted: true,
			lastSpeechTime: speechEndTime,
		})
		const now = minChunkDuration + speechEndTime + silenceTimeout
		const result = evaluateVad(state, now, 0, params)
		expect(result.cut).toBe(true)
	})

	it('does not cut if silenceTimeout has not elapsed after speech', () => {
		// Place the lastSpeechTime just before 'now', so silence < silenceTimeout
		const now = minChunkDuration + 500
		const state = makeState({
			startTime: 0,
			hasSpeechStarted: true,
			// Speech ended only silenceTimeout/2 ms ago — not long enough to trigger cut
			lastSpeechTime: now - Math.floor(silenceTimeout / 2),
		})
		const result = evaluateVad(state, now, 0, params)
		expect(result.cut).toBe(false)
	})
})
