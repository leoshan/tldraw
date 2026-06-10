/**
 * Speech-to-text provider abstraction.
 *
 * Supported backends:
 *   openai     : OpenAI Whisper-1 (or any OpenAI-compatible STT endpoint)
 *   sensevoice : Self-deployed SenseVoice via FunASR HTTP server
 *
 * Environment variables:
 *   STT_PROVIDER      = auto|openai|sensevoice  (default: auto)
 *   OPENAI_STT_MODEL  = whisper-1               (default)
 *   SENSEVOICE_URL    = http://localhost:7861    (FunASR HTTP server default)
 *
 * ── SenseVoice deployment ────────────────────────────────────────────────────
 * Start the FunASR HTTP server with SenseVoiceSmall:
 *
 *   pip install funasr modelscope
 *   python -m funasr.bin.inference \
 *     --model iic/SenseVoiceSmall \
 *     --serving-port 7861
 *
 * Or use the official Docker image:
 *   https://github.com/modelscope/FunASR#service-deployment
 *
 * Expected REST endpoint (FunASR HTTP format):
 *   POST {SENSEVOICE_URL}/api/v1/asr
 *   Body: { "audio_in": "<base64>", "audio_format": "webm|ogg", "lang": "auto" }
 *   Response: { "code": 0, "data": "<transcribed text>" }
 *
 * To add a new provider implement SttProvider and extend createSttProvider().
 */

import OpenAI, { toFile } from 'openai'

// ── Public interface ──────────────────────────────────────────────────────────

export interface SttProvider {
	readonly name: string
	/** Transcribes audio from a base64-encoded buffer. Returns the raw text. */
	transcribe(audioBase64: string, mimeType: string): Promise<string>
}

// ── Provider: OpenAI Whisper ──────────────────────────────────────────────────

class OpenAISttProvider implements SttProvider {
	readonly name: string

	constructor(
		private readonly openai: OpenAI,
		private readonly model: string
	) {
		this.name = `openai:${model}`
	}

	async transcribe(audioBase64: string, mimeType: string): Promise<string> {
		const buffer = Buffer.from(audioBase64, 'base64')
		const ext = mimeType.includes('ogg') ? 'ogg' : 'webm'
		const file = await toFile(buffer, `audio.${ext}`, { type: mimeType })
		const result = await this.openai.audio.transcriptions.create({
			model: this.model,
			file,
		})
		return result.text.trim()
	}
}

// ── Provider: SenseVoice (FunASR HTTP server) ─────────────────────────────────

class SenseVoiceSttProvider implements SttProvider {
	readonly name: string

	constructor(private readonly baseUrl: string) {
		this.name = `sensevoice:${baseUrl}`
	}

	async transcribe(audioBase64: string, mimeType: string): Promise<string> {
		const fmt = mimeType.includes('ogg') ? 'ogg' : 'webm'
		const resp = await fetch(`${this.baseUrl}/api/v1/asr`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				audio_in: audioBase64,
				audio_format: fmt,
				lang: 'auto',
			}),
		})

		if (!resp.ok) {
			const err = await resp.text().catch(() => `HTTP ${resp.status}`)
			throw new Error(`SenseVoice ASR error: ${err}`)
		}

		const json: any = await resp.json()
		// FunASR returns { code, data } — some wrappers return { text } or { result }
		const text: string = json?.data ?? json?.text ?? json?.result ?? ''
		if (!text) throw new Error('SenseVoice returned empty transcript')
		return text.trim()
	}
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the active SttProvider based on environment variables.
 *
 * STT_PROVIDER=auto (default)
 *   → uses OpenAI if OPENAI_API_KEY is set, otherwise SenseVoice
 *
 * STT_PROVIDER=openai
 *   → always uses OpenAI Whisper (requires OPENAI_API_KEY)
 *
 * STT_PROVIDER=sensevoice
 *   → always uses SenseVoice (requires a running FunASR HTTP server)
 *
 * Returns null only when mode=openai and no API key is configured.
 */
export function createSttProvider(openai: OpenAI | null): SttProvider | null {
	const mode = (process.env.STT_PROVIDER ?? 'auto').toLowerCase()
	const senseVoiceUrl = (process.env.SENSEVOICE_URL ?? 'http://localhost:7861').replace(/\/+$/, '')
	const openaiModel = process.env.OPENAI_STT_MODEL ?? 'whisper-1'

	if (mode === 'sensevoice') {
		return new SenseVoiceSttProvider(senseVoiceUrl)
	}

	if (mode === 'openai') {
		if (!openai) return null
		return new OpenAISttProvider(openai, openaiModel)
	}

	// auto: prefer OpenAI when key is available, fall back to SenseVoice
	if (openai) return new OpenAISttProvider(openai, openaiModel)
	return new SenseVoiceSttProvider(senseVoiceUrl)
}
