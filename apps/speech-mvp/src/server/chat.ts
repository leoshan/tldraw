/**
 * Chat/text provider abstraction (used for agent replies and sliding-window summaries).
 *
 * Supported backends:
 *   openai : OpenAI chat completions (gpt-4o-mini by default)
 *   local  : Any Ollama / vLLM / LM-Studio endpoint that speaks the
 *            OpenAI-compatible /v1/chat/completions API.
 *            Uses fetch + manual SSE parsing to avoid OpenAI SDK compatibility
 *            issues with Ollama's streaming implementation.
 *
 * Environment variables:
 *   CHAT_PROVIDER      = auto | openai | local  (default: auto)
 *   OPENAI_CHAT_MODEL  = gpt-4o-mini            (default)
 *   LOCAL_CHAT_URL     = http://localhost:11434  (Ollama default)
 *   LOCAL_CHAT_MODEL   = gemma4                 (default)
 */

import OpenAI from 'openai'

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
}

export interface ChatConfig {
	readonly name: string
	readonly model: string
	/**
	 * Streams a chat completion. Each iteration yields a text delta.
	 * Throws on network or model errors.
	 */
	streamMessages(messages: ChatMessage[], maxTokens?: number): AsyncIterable<string>
}

// ── Provider: OpenAI ─────────────────────────────────────────────────────────

class OpenAIChatConfig implements ChatConfig {
	readonly name: string
	readonly model: string

	constructor(
		private readonly openai: OpenAI,
		model: string
	) {
		this.model = model
		this.name = `openai:${model}`
	}

	async *streamMessages(messages: ChatMessage[], maxTokens = 500): AsyncIterable<string> {
		const stream = await this.openai.chat.completions.create({
			model: this.model,
			messages,
			stream: true,
			max_tokens: maxTokens,
		})
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content ?? ''
			if (delta) yield delta
		}
	}
}

// ── Provider: Local (Ollama / vLLM / LM Studio) ───────────────────────────────
//
// Uses fetch + manual SSE parsing — identical to LocalVisionProvider — to avoid
// OpenAI SDK stream-handling quirks with Ollama (empty deltas, hung iterators).

class LocalChatConfig implements ChatConfig {
	readonly name: string
	readonly model: string

	constructor(
		private readonly baseUrl: string,
		model: string
	) {
		this.model = model
		this.name = `local:${model}@${baseUrl}`
	}

	async *streamMessages(messages: ChatMessage[], maxTokens = 500): AsyncIterable<string> {
		const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: this.model,
				messages,
				stream: true,
				max_tokens: maxTokens,
			}),
		})

		if (!resp.ok) {
			const err = await resp.text().catch(() => `HTTP ${resp.status}`)
			throw new Error(`Local chat model error (${resp.status}): ${err}`)
		}
		if (!resp.body) throw new Error('No response body from local chat model')

		// Parse newline-delimited SSE ("data: {...}\n\n")
		const decoder = new TextDecoder()
		const reader = resp.body.getReader()
		let buf = ''

		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buf += decoder.decode(value, { stream: true })
			const lines = buf.split('\n')
			buf = lines.pop() ?? ''

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed.startsWith('data:')) continue
				const payload = trimmed.slice(5).trim()
				if (payload === '[DONE]') return
				try {
					const parsed = JSON.parse(payload)
					const delta = parsed?.choices?.[0]?.delta?.content ?? ''
					if (delta) yield delta
				} catch {
					// malformed SSE line — skip
				}
			}
		}
	}
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createChatConfig(openai: OpenAI | null): ChatConfig | null {
	const mode = (process.env.CHAT_PROVIDER ?? 'auto').toLowerCase()
	const localUrl = (process.env.LOCAL_CHAT_URL ?? 'http://localhost:11434').replace(/\/+$/, '')
	const localModel = process.env.LOCAL_CHAT_MODEL ?? 'gemma4'
	const openaiModel = process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini'

	if (mode === 'local') {
		return new LocalChatConfig(localUrl, localModel)
	}

	if (mode === 'openai') {
		if (!openai) return null
		return new OpenAIChatConfig(openai, openaiModel)
	}

	// auto: prefer OpenAI when key is present, otherwise fall back to local Ollama
	if (openai) return new OpenAIChatConfig(openai, openaiModel)
	return new LocalChatConfig(localUrl, localModel)
}
