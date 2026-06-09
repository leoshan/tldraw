// Load .env file into process.env (dev only; silently skipped if missing)
import { readFileSync } from 'fs'
import { resolve } from 'path'
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
import OpenAI, { toFile } from 'openai'
import type { RawData } from 'ws'
import {
	createAgentShape,
	createAnnotationShapes,
	createImageShapeInRoom,
	createOcrShape,
	getOrCreateRoom,
	getRoomContextText,
	updateAgentShape,
	writeSpeechToRoom,
} from './rooms.js'
import { createVisionProvider } from './vision.js'

const PORT = 5858

const openai = process.env.OPENAI_API_KEY
	? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
	: null

const visionProvider = createVisionProvider(openai)

const app = fastify()
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
			if (!openai) {
				// No API key: stream a mock response so the MVP can be tested without OpenAI
				const words =
					`(Mock — set OPENAI_API_KEY to use a real model)\n\n` + `Prompt received: "${prompt}"`
				let accumulated = ''
				for (const word of words.split('')) {
					accumulated += word
					updateAgentShape(roomId, shapeId, accumulated)
					send({ delta: word, shapeId })
					await new Promise((r) => setTimeout(r, 15))
				}
			} else {
				let accumulated = ''
				const stream = await openai.chat.completions.create({
					model: 'gpt-4o-mini',
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
	// Decodes audio, calls Whisper, writes result as a speech shape.
	app.post('/transcribe', async (req, res) => {
		const { audio, mimeType, roomId, x, y } = req.body as any
		if (!audio || !roomId) {
			return res.status(400).send({ error: 'audio and roomId required' })
		}
		const clickX = typeof x === 'number' ? x : undefined
		const clickY = typeof y === 'number' ? y : undefined

		let text: string
		if (!openai) {
			text = '🔊 （系统音频转写需要 OPENAI_API_KEY）'
		} else {
			try {
				const buffer = Buffer.from(audio as string, 'base64')
				const ext = (mimeType as string)?.includes('ogg') ? 'ogg' : 'webm'
				const file = await toFile(buffer, `audio.${ext}`, {
					type: (mimeType as string) ?? 'audio/webm',
				})
				const result = await openai.audio.transcriptions.create({
					model: 'whisper-1',
					file,
				})
				text = result.text.trim()
			} catch (err: any) {
				return res.status(500).send({ error: err.message })
			}
		}

		if (!text) return res.send({ ok: true, text: '', shapeId: null })

		const shapeId = writeSpeechToRoom(roomId, '🔊 ' + text, true, clickX, clickY)
		return res.send({ ok: true, text, shapeId })
	})

	// ── Annotation endpoint ────────────────────────────────────────────────────
	// Body: { roomId: string, shapeIds: string[] }
	// Creates a dashed geo frame + arrow + SummaryCard around the given shapes.
	app.post('/annotate', async (req, res) => {
		const { roomId, shapeIds } = req.body as any
		if (!roomId || !Array.isArray(shapeIds) || shapeIds.length === 0) {
			return res.status(400).send({ error: 'roomId and non-empty shapeIds required' })
		}
		const result = createAnnotationShapes(roomId, shapeIds as any)
		if (!result) {
			return res.status(404).send({ error: 'no matching shapes found' })
		}
		return res.send({ ok: true, ...result })
	})

	// ── Vision / multimodal image analysis endpoint ────────────────────────────
	// Body: { image: base64, mimeType: string, roomId: string, w: number, h: number, x?, y? }
	// Response: text/event-stream (SSE) — analysis tokens streamed to canvas.
	//
	// Provider selection (VISION_PROVIDER env var):
	//   auto   → OpenAI if OPENAI_API_KEY set, else local Ollama
	//   openai → GPT-4o (requires OPENAI_API_KEY)
	//   local  → Ollama/vLLM at LOCAL_VISION_URL with LOCAL_VISION_MODEL
	app.post('/vision', async (req, res) => {
		const { image, mimeType, roomId, w, h, x, y } = req.body as any
		if (!image || !roomId) {
			return res.status(400).send({ error: 'image and roomId required' })
		}

		const clickX = typeof x === 'number' ? x : undefined
		const clickY = typeof y === 'number' ? y : undefined
		const srcW = typeof w === 'number' && w > 0 ? w : 800
		const srcH = typeof h === 'number' && h > 0 ? h : 600
		const mime = (mimeType as string) || 'image/png'

		// Create image shape + agent placeholder in the room
		const { agentShapeId, agentX, agentY } = createImageShapeInRoom(
			roomId,
			image as string,
			mime,
			srcW,
			srcH,
			clickX,
			clickY
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
				updateAgentShape(roomId, agentShapeId, stub)
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
				updateAgentShape(roomId, agentShapeId, '📷 ' + accumulated)
				send({ delta, agentShapeId })
			}

			// ── Layer C: split summary from OCR at the separator ──────────────
			// Model is asked to output "---OCR---" between description and extracted text.
			const parts = accumulated.split(/---\s*OCR\s*---/i)
			const summary = parts[0].trim()
			const ocrText = parts[1]?.trim()

			// Finalize summary card with only the description text
			updateAgentShape(roomId, agentShapeId, '📷 ' + summary)

			// Create a separate OCR shape below the summary card (if content exists)
			let ocrShapeId: string | null = null
			if (ocrText) {
				// Estimate summary card height at size 's', w=260: ~22px/line, ~20 chars/line
				const summaryLines = Math.ceil(summary.length / 20) + 1
				const estimatedSummaryH = summaryLines * 22
				ocrShapeId = createOcrShape(roomId, agentX, agentY + estimatedSummaryH + 16, ocrText)
			}

			send({ done: true, agentShapeId, ocrShapeId })
		} catch (err: any) {
			const errMsg = `📷 分析失败：${err.message}`
			updateAgentShape(roomId, agentShapeId, errMsg)
			send({ error: err.message })
		} finally {
			res.raw.end()
		}
	})
})

app.listen({ port: PORT }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
	console.warn(`Speech MVP server on http://localhost:${PORT}`)
	console.warn(`OpenAI: ${openai ? 'enabled' : 'mock mode (no OPENAI_API_KEY)'}`)
	console.warn(
		`Vision provider: ${visionProvider ? visionProvider.name : 'none (set OPENAI_API_KEY or start Ollama)'}`
	)
})
