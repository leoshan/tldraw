/**
 * Vision provider abstraction for multimodal image analysis.
 *
 * Supported backends:
 *   - openai   : GPT-4o vision (commercial, requires OPENAI_API_KEY)
 *   - local    : Any Ollama/vLLM/LM-Studio endpoint that speaks the
 *                OpenAI-compatible /v1/chat/completions API.
 *                Tested models: qwen2-vl, qwen2.5-vl, llava, llama3.2-vision
 *
 * Environment variables:
 *   VISION_PROVIDER      = auto | openai | local  (default: auto)
 *   OPENAI_VISION_MODEL  = gpt-4o                 (default)
 *   LOCAL_VISION_URL     = http://localhost:11434  (Ollama default)
 *   LOCAL_VISION_MODEL   = qwen2-vl:7b             (default)
 *
 * To add a new provider implement the VisionProvider interface and extend
 * createVisionProvider().
 */

import OpenAI from 'openai'

// ── Public interface ──────────────────────────────────────────────────────────

export interface VisionAnalysisParams {
	imageBase64: string
	mimeType: string
	contextText?: string // existing whiteboard text, passed as conversation context
}

/**
 * A VisionProvider streams analysis tokens for a single image.
 * Each iteration yields a text delta (one or more characters).
 */
export interface VisionProvider {
	readonly name: string
	analyzeImage(params: VisionAnalysisParams): AsyncIterable<string>
}

// ── Prompt builders ───────────────────────────────────────────────────────────

const VISION_INSTRUCTION = `\
你是专业的会议记录助手，正在分析会议中共享的屏幕截图。

直接输出核心内容概括（3-5句），严格遵守：
1. 抓关键，不泛化 — 给出具体的结论/数据/决策/问题，禁止输出"这是一张图表""这是一个界面"等无信息量的描述。
2. 按内容类型聚焦：
   · PPT/幻灯片 → 本页核心观点、关键数据、结论
   · 图表/数据报表 → 趋势、关键数字、异常、对比结论
   · 代码/技术文档 → 功能目的、语言/框架、核心逻辑或问题点
   · 产品/设计稿 → 功能模块、交互逻辑、待确认问题
   · 文档/邮件 → 主旨、核心结论、行动项
   · 白板/手写 → 议题、结构化要点、关键词
3. 若截图包含白板中已有的上下文内容，指出与当前讨论的关联。
4. 不输出任何标题、编号、多余说明。

若截图中有可见文字，另起一行输出 "---OCR---"，再逐行列出文字原文（保持原始顺序和分组）。无文字则不输出分隔行。总 token 不超过 350。`

/** OpenAI format: system + user with image. Works with GPT-4o. */
function buildOpenAIMessages(
	imageBase64: string,
	mimeType: string,
	contextText?: string
): Array<{ role: string; content: any }> {
	const userContent: any[] = [
		{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
	]
	if (contextText?.trim()) {
		userContent.push({
			type: 'text',
			text: `当前白板已有的语音/文字内容（供关联分析使用）：\n${contextText.slice(0, 1500)}`,
		})
	}
	return [
		{ role: 'system', content: VISION_INSTRUCTION },
		{ role: 'user', content: userContent },
	]
}

/**
 * Local/Ollama format: single user message with instruction text + image.
 * Avoids system role — some Ollama-hosted models (gemma etc.) return empty
 * content when a system message is present.
 * Text is placed BEFORE the image so the model reads the task first.
 */
function buildLocalMessages(
	imageBase64: string,
	mimeType: string,
	contextText?: string
): Array<{ role: string; content: any }> {
	let instruction = VISION_INSTRUCTION
	if (contextText?.trim()) {
		instruction += `\n\n当前白板已有的语音/文字内容（供关联分析使用）：\n${contextText.slice(0, 1500)}`
	}
	return [
		{
			role: 'user',
			content: [
				{ type: 'text', text: instruction },
				{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
			],
		},
	]
}

// ── Provider: OpenAI GPT-4o ───────────────────────────────────────────────────

class OpenAIVisionProvider implements VisionProvider {
	readonly name: string

	constructor(
		private readonly openai: OpenAI,
		model: string
	) {
		this.name = `openai:${model}`
		this._model = model
	}

	private readonly _model: string

	async *analyzeImage({ imageBase64, mimeType, contextText }: VisionAnalysisParams) {
		const messages = buildOpenAIMessages(imageBase64, mimeType, contextText) as any
		const stream = await this.openai.chat.completions.create({
			model: this._model,
			messages,
			stream: true,
			max_tokens: 450,
		})
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content ?? ''
			if (delta) yield delta
		}
	}
}

// ── Provider: Local (Ollama / vLLM / LM Studio) ───────────────────────────────
//
// Uses the OpenAI SDK pointing at the local endpoint's /v1 base URL.
// This matches how /agent works and avoids fetch+SSE compatibility issues
// with some Ollama versions.
//
// Messages use a single user message (no system role) for compatibility with
// models like gemma that return empty content when system role is present.
//
// Tested models: qwen2-vl, qwen2.5-vl, llava, llama3.2-vision, gemma3
// Pull example: ollama pull gemma3:12b  (if it supports vision)

class LocalVisionProvider implements VisionProvider {
	readonly name: string
	private readonly _model: string
	private readonly _client: OpenAI

	constructor(baseUrl: string, model: string) {
		this._model = model
		this.name = `local:${model}`
		this._client = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: 'ollama' })
	}

	async *analyzeImage({ imageBase64, mimeType, contextText }: VisionAnalysisParams) {
		const messages = buildLocalMessages(imageBase64, mimeType, contextText) as any
		const stream = await this._client.chat.completions.create({
			model: this._model,
			messages,
			stream: true,
			max_tokens: 450,
		})
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content ?? ''
			if (delta) yield delta
		}
	}
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the active VisionProvider based on environment variables.
 *
 * VISION_PROVIDER=auto (default)
 *   → uses OpenAI if OPENAI_API_KEY is set, otherwise local
 *
 * VISION_PROVIDER=openai
 *   → always uses OpenAI (requires OPENAI_API_KEY)
 *
 * VISION_PROVIDER=local
 *   → always uses local (requires a running Ollama/vLLM instance)
 *
 * Returns null when no usable provider is configured.
 */
export function createVisionProvider(openai: OpenAI | null): VisionProvider | null {
	const mode = (process.env.VISION_PROVIDER ?? 'auto').toLowerCase()
	const localUrl = (process.env.LOCAL_VISION_URL ?? 'http://localhost:11434').replace(/\/+$/, '')
	const localModel = process.env.LOCAL_VISION_MODEL ?? 'qwen2-vl:7b'
	const openaiModel = process.env.OPENAI_VISION_MODEL ?? 'gpt-4o'

	if (mode === 'local') {
		return new LocalVisionProvider(localUrl, localModel)
	}

	if (mode === 'openai') {
		if (!openai) return null
		return new OpenAIVisionProvider(openai, openaiModel)
	}

	// auto: prefer OpenAI when key is available
	if (openai) return new OpenAIVisionProvider(openai, openaiModel)
	return new LocalVisionProvider(localUrl, localModel)
}
