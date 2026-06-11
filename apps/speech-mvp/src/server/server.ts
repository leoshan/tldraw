// Load .env file into process.env (dev only; silently skipped if missing)
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
try {
	for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq < 1) continue
		const key = trimmed.slice(0, eq)
		if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1)
	}
} catch {
	// .env not found — expected in production
}

import cors from '@fastify/cors'
import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import OpenAI from 'openai'
import type { RawData } from 'ws'
import { createChatConfig } from './chat.js'
import {
	SUMMARY_CHAR_THRESHOLD,
	setRoomActivePage,
	createAgentShape,
	createAnnotationShapes,
	createImageShapeInRoom,
	createOcrShape,
	createSummaryCard,
	getOrCreateRoom,
	getOrSetImageColumnX,
	getRoomContextText,
	getRoomSnapshot,
	listCheckpoints,
	loadCheckpointSnapshot,
	resetCharCount,
	saveCheckpoint,
	trackSpeechText,
	updateAgentShape,
	updateShapeText,
	writeSpeechToRoom,
	getRoomSummaries,
	createMinutesCard,
	getSelectedContent,
} from './rooms.js'
import { createSttProvider } from './stt.js'
import { appendTranscript, getTranscriptFilePath } from './transcript.js'
import { createVisionProvider } from './vision.js'

const PORT = 5858

const openai = process.env.OPENAI_API_KEY
	? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
	: null

const visionProvider = createVisionProvider(openai)
const sttProvider = createSttProvider(openai)
const chatConfig = createChatConfig(openai)

// ── ④ Sliding window summary ─────────────────────────────────────────────────
// Fire-and-forget: called after each final speech result when the char threshold
// is met. Creates an orange SummaryCard and streams the model output into it.
async function triggerWindowSummary(roomId: string, windowText: string): Promise<void> {
	const shapeId = createSummaryCard(roomId, '📋 摘要生成中…')
	if (!chatConfig) {
		updateShapeText(roomId, shapeId, '📋（摘要需要 OPENAI_API_KEY 或 CHAT_PROVIDER=local）')
		return
	}
	try {
		// Single user message — avoids system-role compatibility issues with some
		// local models (gemma etc.) in Ollama's OpenAI-compatible mode.
		const stream = await chatConfig.client.chat.completions.create({
			model: chatConfig.model,
			messages: [
				{
					role: 'user',
					content: `请将以下会议转写片段概括为 3-5 个要点，每点以"· "开头单独一行，直接输出要点，不要标题或多余说明，不超过 150 字。\n\n---\n${windowText}`,
				},
			],
			stream: true,
		})
		let accumulated = ''
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content ?? ''
			if (!delta) continue
			accumulated += delta
			updateShapeText(roomId, shapeId, '📋 ' + accumulated)
		}
		if (!accumulated) {
			updateShapeText(roomId, shapeId, `📋 摘要失败：模型返回了空内容（${chatConfig.name}）`)
		}
	} catch (err: any) {
		console.error('[triggerWindowSummary]', err)
		updateShapeText(roomId, shapeId, `📋 摘要失败：${err.message}`)
	}
}

const app = fastify({ bodyLimit: 20 * 1024 * 1024 }) // 20 MB — screenshots can be large base64 payloads
app.register(websocketPlugin)
app.register(cors, { origin: '*' })

app.register(async (app) => {
	// ── tldraw sync WebSocket endpoint ────────────────────────────────────────
	// Pattern copied verbatim from templates/simple-server-example/src/server/server.ts
	app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
		const roomId = (req.params as any).roomId as string
		const sessionId = (req.query as any)?.['sessionId'] as string

		// Buffer messages that arrive before async room setup completes.
		// See: https://github.com/fastify/fastify-websocket#attaching-event-handlers
		const caughtMessages: RawData[] = []
		const collectMessages = (msg: RawData) => caughtMessages.push(msg)
		socket.on('message', collectMessages)

		const room = getOrCreateRoom(roomId)
		room.handleSocketConnect({ sessionId, socket })

		socket.off('message', collectMessages)
		for (const msg of caughtMessages) socket.emit('message', msg)
	})

	// ── Speech endpoint ────────────────────────────────────────────────────────
	// Body: { text: string, isFinal: boolean, roomId: string }
	app.post('/speech', async (req, res) => {
		const { text, isFinal, roomId, x, y } = req.body as any
		if (!text || !roomId) {
			return res.status(400).send({ error: 'text and roomId required' })
		}
		const clickX = typeof x === 'number' ? x : undefined
		const clickY = typeof y === 'number' ? y : undefined
		const shapeId = writeSpeechToRoom(roomId, String(text), Boolean(isFinal), clickX, clickY)

		// ③ Transcript + ④ summary only on final results
		if (isFinal) {
			appendTranscript(roomId, String(text), clickX ?? 40, clickY ?? 80)
			const { charCount, windowText } = trackSpeechText(roomId, String(text))
			if (charCount >= SUMMARY_CHAR_THRESHOLD) {
				resetCharCount(roomId)
				triggerWindowSummary(roomId, windowText).catch(console.error)
			}
		}

		return res.send({ ok: true, shapeId })
	})

	// ── Agent / LLM streaming endpoint ────────────────────────────────────────
	// Body: { prompt: string, roomId: string }
	// Response: text/event-stream (SSE) so the browser can show streaming status.
	// Canvas updates happen server-side via storage.transaction on each token.
	app.post('/agent', async (req, res) => {
		const { prompt, roomId, x, y } = req.body as any
		if (!prompt || !roomId) {
			return res.status(400).send({ error: 'prompt and roomId required' })
		}

		const clickX = typeof x === 'number' ? x : undefined
		const clickY = typeof y === 'number' ? y : undefined
		const shapeId = createAgentShape(roomId, clickX, clickY)

		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		})

		const send = (data: object) => res.raw.write(`data: ${JSON.stringify(data)}\n\n`)

		try {
			if (!chatConfig) {
				// No provider configured: stream a mock response for local testing
				const words =
					`(Mock — set OPENAI_API_KEY or CHAT_PROVIDER=local to use a real model)\n\n` +
					`Prompt received: "${prompt}"`
				let accumulated = ''
				for (const word of words.split('')) {
					accumulated += word
					updateAgentShape(roomId, shapeId, accumulated)
					send({ delta: word, shapeId })
					await new Promise((r) => setTimeout(r, 15))
				}
			} else {
				let accumulated = ''
				const stream = await chatConfig.client.chat.completions.create({
					model: chatConfig.model,
					messages: [{ role: 'user', content: prompt }],
					stream: true,
				})
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta?.content ?? ''
					if (!delta) continue
					accumulated += delta
					updateAgentShape(roomId, shapeId, accumulated)
					send({ delta, shapeId })
				}
			}
			send({ done: true, shapeId })
		} catch (err: any) {
			send({ error: err.message })
		} finally {
			res.raw.end()
		}
	})

	// ── System-audio transcription endpoint ───────────────────────────────────
	// Body: { audio: base64, mimeType: string, roomId: string, x?, y? }
	// Delegates to the active SttProvider (OpenAI Whisper or SenseVoice).
	app.post('/transcribe', async (req, res) => {
		const { audio, mimeType, roomId, x, y } = req.body as any
		if (!audio || !roomId) {
			return res.status(400).send({ error: 'audio and roomId required' })
		}
		const clickX = typeof x === 'number' ? x : undefined
		const clickY = typeof y === 'number' ? y : undefined

		let text: string
		if (!sttProvider) {
			text =
				'🔊 （语音转写未配置：请设置 OPENAI_API_KEY 或启动 SenseVoice 并设置 STT_PROVIDER=sensevoice）'
		} else {
			try {
				text = await sttProvider.transcribe(audio as string, (mimeType as string) ?? 'audio/webm')
			} catch (err: any) {
				return res.status(500).send({ error: err.message })
			}
		}

		if (!text) return res.send({ ok: true, text: '', shapeId: null })

		const shapeId = writeSpeechToRoom(roomId, '🔊 ' + text, true, clickX, clickY)

		// ③ Transcript + ④ summary
		appendTranscript(roomId, '🔊 ' + text, clickX ?? 40, clickY ?? 80)
		const { charCount, windowText } = trackSpeechText(roomId, text)
		if (charCount >= SUMMARY_CHAR_THRESHOLD) {
			resetCharCount(roomId)
			triggerWindowSummary(roomId, windowText).catch(console.error)
		}

		return res.send({ ok: true, text, shapeId })
	})

	// ── Annotation endpoint ────────────────────────────────────────────────────
	// Body: { roomId: string, shapeIds: string[] }
	// Creates a dashed geo frame + arrow + SummaryCard around the given shapes and streams LLM summary.
	app.post('/annotate', async (req, res) => {
		const { roomId, shapeIds } = req.body as any
		if (!roomId || !Array.isArray(shapeIds) || shapeIds.length === 0) {
			return res.status(400).send({ error: 'roomId and non-empty shapeIds required' })
		}

		const result = createAnnotationShapes(roomId, shapeIds as any, '🗂 正在为您总结概括所选内容…')
		if (!result) {
			return res.status(404).send({ error: 'no matching shapes found' })
		}

		const content = getSelectedContent(roomId, shapeIds as any)
		const promptText = `你是一个白板内容总结与标注分析助手。请对用户在白板上框选的这些内容（包含文本和图片）进行总结和提炼，概括出核心论点、讨论议题或主要结论。
要求：
1. 语言必须简明扼要，控制在 3-5 句以内。
2. 绝对不能使用 Markdown 格式（严禁输出任何井号 #、星号 *、减号 - 等 Markdown 语法字符）。
3. 使用换行和纯文本空格进行简单的排版分段，确保在白板上以纯文本的形式具有极高的可读性。
4. 直接输出总结的纯文本内容，不要带有任何多余的解释、前缀或开头语。`

		const messages: any[] = []
		const userContent: any[] = [{ type: 'text', text: promptText }]

		if (content.texts.length > 0) {
			userContent.push({
				type: 'text',
				text: `框选的文本内容如下：\n---\n${content.texts.join('\n')}\n---`,
			})
		}

		for (const img of content.images) {
			userContent.push({
				type: 'image_url',
				image_url: { url: img.base64 },
			})
		}

		messages.push({ role: 'user', content: userContent })

		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		})

		const send = (data: object) => res.raw.write(`data: ${JSON.stringify(data)}\n\n`)

		try {
			if (!chatConfig) {
				const mockSummary = `🗂 框选总结 (打桩)\n\n已成功对选中的 ${shapeIds.length} 个图形进行标注。\n- 文本内容: ${content.texts.length} 段\n- 图片内容: ${content.images.length} 张\n\n（未配置大模型，请配置环境变量后重试）`
				let accumulated = ''
				for (const char of mockSummary.split('')) {
					accumulated += char
					updateShapeText(roomId, result.summaryId, accumulated)
					send({ delta: char, summaryId: result.summaryId })
					await new Promise((r) => setTimeout(r, 10))
				}
			} else {
				let accumulated = ''
				const stream = await chatConfig.client.chat.completions.create({
					model: chatConfig.model,
					messages,
					stream: true,
				})
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta?.content ?? ''
					if (!delta) continue
					accumulated += delta
					updateShapeText(roomId, result.summaryId, '🗂 ' + accumulated)
					send({ delta, summaryId: result.summaryId })
				}
			}
			send({ done: true, summaryId: result.summaryId })
		} catch (err: any) {
			updateShapeText(roomId, result.summaryId, `🗂 总结生成失败：${err.message}`)
			send({ error: err.message })
		} finally {
			res.raw.end()
		}
	})

	// ── Vision / multimodal image analysis endpoint ────────────────────────────
	// Body: { image: base64, mimeType: string, roomId: string, w: number, h: number,
	//         x?, y?, viewport?: { x, y, w, h } }
	// Response: text/event-stream (SSE) — analysis tokens streamed to canvas.
	//
	// Layout with viewport: image fills left 2/3, summary/OCR in right 1/3.
	// Without viewport: image at click position (640px max), summary 20px to its right.
	//
	// Provider selection (VISION_PROVIDER env var):
	//   auto   → OpenAI if OPENAI_API_KEY set, else local Ollama
	//   openai → GPT-4o (requires OPENAI_API_KEY)
	//   local  → Ollama/vLLM at LOCAL_VISION_URL with LOCAL_VISION_MODEL
	app.post('/vision', async (req, res) => {
		const { image, mimeType, roomId, w, h, x, y, viewport } = req.body as any
		if (!image || !roomId) {
			return res.status(400).send({ error: 'image and roomId required' })
		}

		const srcW = typeof w === 'number' && w > 0 ? w : 800
		const srcH = typeof h === 'number' && h > 0 ? h : 600
		const mime = (mimeType as string) || 'image/png'

		// ── Layout: viewport-based (2/3 image + 1/3 summary) or fallback ──────
		const vp = viewport && typeof viewport.w === 'number' && viewport.w > 0 ? viewport : null

		let imgX: number | undefined
		let imgY: number | undefined
		let targetDisplayW: number | undefined
		let summaryOverrideX: number | undefined
		let summaryW: number

		if (vp) {
			const leftPanelW = Math.floor(vp.w * (2 / 3))
			// Pin X to the first image ever placed in this room so every subsequent
			// screenshot/upload aligns to the same left edge even if the viewport
			// has scrolled horizontally between shots.
			// imgY intentionally left undefined — auto-stacks below existing content.
			imgX = getOrSetImageColumnX(roomId, vp.x + 10)
			targetDisplayW = leftPanelW - 20
			summaryOverrideX = imgX + leftPanelW + 10
			summaryW = 320 // Fixed narrow width for comfortable reading
		} else {
			imgX = typeof x === 'number' ? x : undefined
			imgY = typeof y === 'number' ? y : undefined
			summaryW = 320 // Fixed narrow width for comfortable reading
		}

		// Create image shape + agent placeholder in the room
		const { agentShapeId, agentX, agentY } = createImageShapeInRoom(
			roomId,
			image as string,
			mime,
			srcW,
			srcH,
			imgX,
			imgY,
			targetDisplayW,
			summaryOverrideX,
			summaryW
		)

		// SSE response — same pattern as /agent
		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		})
		const send = (data: object) => res.raw.write(`data: ${JSON.stringify(data)}\n\n`)

		try {
			if (!visionProvider) {
				// No provider configured — write stub and explain
				const stub =
					`📷 图片已插入白板\n\n` +
					`（视觉分析未配置：请设置 OPENAI_API_KEY 使用 GPT-4o，` +
					`或启动 Ollama 并设置 LOCAL_VISION_MODEL 使用本地模型）`
				updateShapeText(roomId, agentShapeId, stub)
				send({ done: true, agentShapeId })
				return
			}

			const contextText = getRoomContextText(roomId)
			let accumulated = ''

			for await (const delta of visionProvider.analyzeImage({
				imageBase64: image as string,
				mimeType: mime,
				contextText,
			})) {
				accumulated += delta
				// Stream the full text while in progress (user sees it build up)
				updateShapeText(roomId, agentShapeId, '📷 ' + accumulated)
				send({ delta, agentShapeId })
			}

			// ── Layer C: split summary from OCR at the separator ──────────────
			// Model is asked to output "---OCR---" between description and extracted text.
			const parts = accumulated.split(/---\s*OCR\s*---/i)
			const summary = parts[0].trim()
			const ocrText = parts[1]?.trim()

			// Finalize summary card with only the description text
			updateShapeText(roomId, agentShapeId, '📷 ' + summary)

			// Create a separate OCR shape below the summary card (if content exists)
			let ocrShapeId: string | null = null
			if (ocrText) {
				// Summary card uses size='m', scale=1 → ~14px per char, ~30px per line.
				const effectiveW = summaryW
				const charsPerLine = Math.max(10, Math.floor(effectiveW / 14))
				const summaryLines = Math.ceil(summary.length / charsPerLine) + 1
				const estimatedSummaryH = summaryLines * 30 + 20
				ocrShapeId = createOcrShape(
					roomId,
					agentX,
					agentY + estimatedSummaryH + 24,
					ocrText,
					effectiveW
				)
			}

			send({ done: true, agentShapeId, ocrShapeId })
		} catch (err: any) {
			const errMsg = `📷 分析失败：${err.message}`
			updateShapeText(roomId, agentShapeId, errMsg)
			send({ error: err.message })
		} finally {
			res.raw.end()
		}
	})

	// GET /rooms
	// Lists all rooms that have a persisted SQLite DB, newest activity first.
	app.get('/rooms', async (_req, res) => {
		const dir = join(process.cwd(), 'data', 'rooms')
		try {
			const files = readdirSync(dir).filter((f) => f.endsWith('.db'))
			const rooms = files
				.map((f) => {
					const roomId = f.replace(/\.db$/, '')
					const mtime = statSync(join(dir, f)).mtimeMs
					return { roomId, lastActive: mtime }
				})
				.sort((a, b) => b.lastActive - a.lastActive)
			return res.send({ rooms })
		} catch {
			return res.send({ rooms: [] })
		}
	})

	// POST /rooms/:roomId/active-page  { pageId: string }
	// Called by the client whenever the user switches pages, so server-side shape
	// creation always targets the page the user is currently viewing.
	app.post('/rooms/:roomId/active-page', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const pageId = (req.body as any)?.pageId as string | undefined
		if (!pageId) return res.status(400).send({ error: 'pageId required' })
		setRoomActivePage(roomId, pageId)
		return res.send({ ok: true })
	})

	// ── Persistence / checkpoint endpoints ───────────────────────────────────────

	// GET /rooms/:roomId/snapshot
	// Returns current canvas as a StoreSnapshot (compatible with editor.loadSnapshot()).
	app.get('/rooms/:roomId/snapshot', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const snapshot = getRoomSnapshot(roomId)
		if (!snapshot) {
			return res.status(404).send({ error: 'Room not found or not loaded' })
		}
		return res.send(snapshot)
	})

	// POST /rooms/:roomId/checkpoint  { name?: string }
	// Saves a named checkpoint of the current canvas state to the room's SQLite DB.
	app.post('/rooms/:roomId/checkpoint', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const name =
			(req.body as any)?.name ||
			`checkpoint-${new Date().toLocaleString('zh-CN').replace(/[/: ]/g, '-')}`
		const meta = saveCheckpoint(roomId, String(name))
		if (!meta) {
			return res.status(404).send({ error: 'Room not found or not loaded' })
		}
		return res.send({ ok: true, checkpoint: meta })
	})

	// GET /rooms/:roomId/checkpoints
	// Lists all saved checkpoints for a room, newest first.
	app.get('/rooms/:roomId/checkpoints', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const checkpoints = listCheckpoints(roomId)
		return res.send({ checkpoints })
	})

	// GET /rooms/:roomId/checkpoints/:id
	// Returns a specific checkpoint's canvas snapshot (compatible with editor.loadSnapshot()).
	app.get('/rooms/:roomId/checkpoints/:id', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const id = parseInt((req.params as any).id, 10)
		if (isNaN(id)) return res.status(400).send({ error: 'Invalid checkpoint id' })
		const snapshot = loadCheckpointSnapshot(roomId, id)
		if (!snapshot) {
			return res.status(404).send({ error: 'Checkpoint not found' })
		}
		return res.send(snapshot)
	})

	// GET /rooms/:roomId/summaries
	// Returns a list of summaries on the specified page of the room as a markdown list.
	app.get('/rooms/:roomId/summaries', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const pageId = (req.query as any)?.pageId as string | undefined
		const summaries = getRoomSummaries(roomId, pageId)
		const markdown = summaries.map((s) => `- ${s}`).join('\n')
		return res.send({ markdown, summaries })
	})

	// POST /rooms/:roomId/minutes
	// Summarizes the summaries on the specified page of the room using LLM and creates a blue shape.
	app.post('/rooms/:roomId/minutes', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const { pageId } = req.body as any
		if (!roomId) return res.status(400).send({ error: 'roomId required' })

		const activePageId = pageId || 'page:page'
		const summaries = getRoomSummaries(roomId, activePageId)
		if (summaries.length === 0) {
			return res.status(400).send({ error: '当前页面没有可以生成会议纪要的橙色摘要卡片' })
		}

		const summariesText = summaries.map((s, idx) => `[要点 ${idx + 1}] ${s}`).join('\n')
		const minutesPrompt = `你是一位专业的会议纪要秘书。下面是会议中按时间顺序生成的阶段性橙色摘要要点列表：\n\n${summariesText}\n\n请将这些阶段性要点进行分类归纳和深入提炼，生成一份排版美观、结构清晰的正式会议纪要。\n要求包含以下模块：\n1. 会议主题与概要分类\n2. 详细决议与核心讨论点\n3. 明确的待办事项与行动项 (Todos)\n4. 总结展望\n输出必须是精炼的 Markdown 格式文本，不要包含多余的废话。`

		const shapeId = createMinutesCard(roomId, activePageId, '📝 正在为您提炼生成会议纪要…')

		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		})

		const send = (data: object) => res.raw.write(`data: ${JSON.stringify(data)}\n\n`)

		try {
			let accumulated = ''
			if (!chatConfig) {
				const mockMinutes = `📝 会议纪要 (本地测试打桩)\n\n### 1. 会议主题\n- 语音模块功能开发与调优\n\n### 2. 核心讨论与决议\n- 解决了 ASR 音频切片静音断句延迟问题。\n- 优化了截图描述宽度为 320px。\n\n### 3. 待办事项 (Todos)\n- [ ] 验证系统音频与麦克风的混音录制功能`
				for (const char of mockMinutes.split('')) {
					accumulated += char
					updateShapeText(roomId, shapeId, accumulated)
					send({ delta: char, shapeId })
					await new Promise((r) => setTimeout(r, 10))
				}
			} else {
				const stream = await chatConfig.client.chat.completions.create({
					model: chatConfig.model,
					messages: [{ role: 'user', content: minutesPrompt }],
					stream: true,
				})
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta?.content ?? ''
					if (!delta) continue
					accumulated += delta
					updateShapeText(roomId, shapeId, '📝 会议纪要\n\n' + accumulated)
					send({ delta, shapeId })
				}
			}

			// Save meeting minutes locally to /root/recorder/minutes/
			try {
				const minutesDir = resolve(process.cwd(), '../../../minutes')
				mkdirSync(minutesDir, { recursive: true })
				const filename = `minutes-${roomId}-${activePageId.replace(':', '_')}-${Date.now()}.md`
				const fullPath = join(minutesDir, filename)
				const fileContent =
					`# 会议纪要 - Room ${roomId}\n- 日期: ${new Date().toLocaleString('zh-CN')}\n\n` +
					(accumulated.startsWith('📝 会议纪要\n\n') ? accumulated.substring(9) : accumulated)
				writeFileSync(fullPath, fileContent, 'utf8')
				console.warn(`Saved meeting minutes locally to ${fullPath}`)
			} catch (fileErr) {
				console.error('Failed to write minutes file locally:', fileErr)
			}

			send({ done: true, shapeId })
		} catch (err: any) {
			updateShapeText(roomId, shapeId, `📝 会议纪要生成失败：${err.message}`)
			send({ error: err.message })
		} finally {
			res.raw.end()
		}
	})

	// ── Transcript download endpoint ───────────────────────────────────────────
	// Returns the room's JSONL transcript file as a downloadable attachment.
	// Each line: { ts, text, x, y }
	app.get('/transcript/:roomId', async (req, res) => {
		const roomId = (req.params as any).roomId as string
		const filePath = getTranscriptFilePath(roomId)
		if (!filePath) {
			return res.status(404).send({ error: 'No transcript found for this room' })
		}
		const content = readFileSync(filePath, 'utf8')
		void res.header('Content-Type', 'application/x-ndjson')
		void res.header('Content-Disposition', `attachment; filename="transcript-${roomId}.jsonl"`)
		return res.send(content)
	})
})

app.listen({ port: PORT }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
	console.warn(`Speech MVP server on http://localhost:${PORT}`)
	console.warn(`OpenAI: ${openai ? 'enabled' : 'not configured (mock mode or local providers)'}`)
	console.warn(
		`Vision provider: ${visionProvider ? visionProvider.name : 'none (set OPENAI_API_KEY or start Ollama)'}`
	)
	console.warn(
		`Chat provider:   ${chatConfig ? chatConfig.name : 'none (set OPENAI_API_KEY or CHAT_PROVIDER=local)'}`
	)
	console.warn(
		`STT provider:    ${sttProvider ? sttProvider.name : 'none (set OPENAI_API_KEY or STT_PROVIDER=sensevoice)'}`
	)
	console.warn(`Transcripts dir: ${resolve(process.cwd(), 'transcripts')}`)
})
