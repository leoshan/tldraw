import cors from '@fastify/cors'
import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import OpenAI from 'openai'
import type { RawData } from 'ws'
import { createAgentShape, getOrCreateRoom, updateAgentShape, writeSpeechToRoom } from './rooms.js'

const PORT = 5858

const openai = process.env.OPENAI_API_KEY
	? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
	: null

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
		const { text, isFinal, roomId } = req.body as any
		if (!text || !roomId) {
			return res.status(400).send({ error: 'text and roomId required' })
		}
		const shapeId = writeSpeechToRoom(roomId, String(text), Boolean(isFinal))
		return res.send({ ok: true, shapeId })
	})

	// ── Agent / LLM streaming endpoint ────────────────────────────────────────
	// Body: { prompt: string, roomId: string }
	// Response: text/event-stream (SSE) so the browser can show streaming status.
	// Canvas updates happen server-side via storage.transaction on each token.
	app.post('/agent', async (req, res) => {
		const { prompt, roomId } = req.body as any
		if (!prompt || !roomId) {
			return res.status(400).send({ error: 'prompt and roomId required' })
		}

		const shapeId = createAgentShape(roomId)

		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
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
})

app.listen({ port: PORT }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
	console.warn(`Speech MVP server on http://localhost:${PORT}`)
	console.warn(`OpenAI: ${openai ? 'enabled' : 'mock mode (no OPENAI_API_KEY)'}`)
})
