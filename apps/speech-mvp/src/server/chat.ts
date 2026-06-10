/**
 * Chat/text provider abstraction (used for agent replies and sliding-window summaries).
 *
 * Supported backends:
 *   openai : OpenAI chat completions (gpt-4o-mini by default)
 *   local  : Any Ollama / vLLM / LM-Studio endpoint that speaks the
 *            OpenAI-compatible /v1/chat/completions API.
 *
 * Environment variables:
 *   CHAT_PROVIDER      = auto | openai | local  (default: auto)
 *   OPENAI_CHAT_MODEL  = gpt-4o-mini            (default)
 *   LOCAL_CHAT_URL     = http://localhost:11434  (Ollama default)
 *   LOCAL_CHAT_MODEL   = gemma4                 (default)
 *
 * In "auto" mode the server prefers OpenAI when OPENAI_API_KEY is set,
 * otherwise falls back to the local endpoint.
 */

import OpenAI from 'openai'

export interface ChatConfig {
	/** The OpenAI-compatible client to use (may point to Ollama). */
	client: OpenAI
	/** Model identifier passed to chat completions. */
	model: string
	/** Human-readable provider name for startup logs. */
	name: string
}

/**
 * Returns a ChatConfig based on environment variables, or null if no
 * usable provider is configured (mode=openai but no API key).
 */
export function createChatConfig(openai: OpenAI | null): ChatConfig | null {
	const mode = (process.env.CHAT_PROVIDER ?? 'auto').toLowerCase()
	const localUrl = process.env.LOCAL_CHAT_URL ?? 'http://localhost:11434'
	const localModel = process.env.LOCAL_CHAT_MODEL ?? 'gemma4'
	const openaiModel = process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini'

	if (mode === 'local') {
		return {
			client: new OpenAI({ baseURL: `${localUrl}/v1`, apiKey: 'ollama' }),
			model: localModel,
			name: `local:${localModel}@${localUrl}`,
		}
	}

	if (mode === 'openai') {
		if (!openai) return null
		return { client: openai, model: openaiModel, name: `openai:${openaiModel}` }
	}

	// auto: prefer OpenAI when key is present, otherwise fall back to local Ollama
	if (openai) {
		return { client: openai, model: openaiModel, name: `openai:${openaiModel}` }
	}
	return {
		client: new OpenAI({ baseURL: `${localUrl}/v1`, apiKey: 'ollama' }),
		model: localModel,
		name: `local:${localModel}@${localUrl}`,
	}
}
