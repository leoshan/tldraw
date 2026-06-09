import { InMemorySyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { getIndexAbove, IndexKey, uniqueId } from '@tldraw/utils'
import {
	createShapeId,
	createTLSchema,
	toRichText,
	type TLArrowShape,
	type TLAssetId,
	type TLGeoShape,
	type TLImageAsset,
	type TLImageShape,
	type TLRecord,
	type TLShapeId,
	type TLTextShape,
} from 'tldraw'

const rooms = new Map<string, TLSocketRoom<TLRecord, void>>()
// Per-room position tracking for stacking shapes
const roomXOffsets = new Map<string, number>()
const roomYOffsets = new Map<string, number>()
// Per-room last used IndexKey for fractional indexing
const roomLastIndex = new Map<string, IndexKey>()
// Per-room in-progress interim speech shape
const interimShapeIds = new Map<string, TLShapeId>()

export function getOrCreateRoom(roomId: string): TLSocketRoom<TLRecord, void> {
	const existing = rooms.get(roomId)
	if (existing && !existing.isClosed()) return existing

	const storage = new InMemorySyncStorage<TLRecord>()
	const room = new TLSocketRoom<TLRecord, void>({
		storage,
		schema: createTLSchema() as any,
		onSessionRemoved(room, { numSessionsRemaining }) {
			if (numSessionsRemaining === 0) {
				setTimeout(() => {
					if (room.isClosed()) return
					room.close()
					rooms.delete(roomId)
					roomXOffsets.delete(roomId)
					roomYOffsets.delete(roomId)
					roomLastIndex.delete(roomId)
					interimShapeIds.delete(roomId)
				}, 10_000)
			}
		},
	})

	rooms.set(roomId, room)
	roomXOffsets.set(roomId, 40)
	roomYOffsets.set(roomId, 80)
	return room
}

function nextPosition(
	roomId: string,
	overrideX?: number,
	overrideY?: number
): { x: number; y: number } {
	if (overrideX !== undefined && overrideY !== undefined) {
		roomXOffsets.set(roomId, overrideX)
		roomYOffsets.set(roomId, overrideY + 130)
		return { x: overrideX, y: overrideY }
	}
	const x = roomXOffsets.get(roomId) ?? 40
	const y = roomYOffsets.get(roomId) ?? 80
	roomYOffsets.set(roomId, y + 130)
	return { x, y }
}

function nextIndex(roomId: string): IndexKey {
	const last = roomLastIndex.get(roomId) ?? ('a0' as IndexKey)
	const next = getIndexAbove(last)
	roomLastIndex.set(roomId, next)
	return next
}

function makeTextShape(
	id: TLShapeId,
	text: string,
	x: number,
	y: number,
	index: IndexKey,
	opacity: number,
	color: TLTextShape['props']['color'] = 'black',
	w = 400,
	size: TLTextShape['props']['size'] = 'm'
): TLTextShape {
	return {
		id,
		typeName: 'shape',
		type: 'text',
		x,
		y,
		rotation: 0,
		index,
		// 'page:page' is the default page created by InMemorySyncStorage's DEFAULT_INITIAL_SNAPSHOT
		parentId: 'page:page' as any,
		isLocked: false,
		opacity,
		props: {
			color,
			size,
			font: 'draw',
			textAlign: 'start',
			w,
			richText: toRichText(text),
			scale: 1,
			autoSize: true,
		},
		meta: {},
	}
}

function makeGeoShape(
	id: TLShapeId,
	x: number,
	y: number,
	w: number,
	h: number,
	index: IndexKey
): TLGeoShape {
	return {
		id,
		typeName: 'shape',
		type: 'geo',
		x,
		y,
		rotation: 0,
		index,
		parentId: 'page:page' as any,
		isLocked: false,
		opacity: 1,
		props: {
			geo: 'rectangle',
			w,
			h,
			dash: 'dashed',
			color: 'orange',
			fill: 'none',
			size: 'm',
			font: 'draw',
			align: 'middle',
			verticalAlign: 'middle',
			growY: 0,
			scale: 1,
			url: '',
			labelColor: 'black',
			richText: toRichText(''),
		},
		meta: {},
	}
}

function makeArrowShape(
	id: TLShapeId,
	startX: number,
	startY: number,
	endDx: number,
	endDy: number,
	index: IndexKey
): TLArrowShape {
	return {
		id,
		typeName: 'shape',
		type: 'arrow',
		// Arrow origin is the start point; start/end are in the shape's local space
		x: startX,
		y: startY,
		rotation: 0,
		index,
		parentId: 'page:page' as any,
		isLocked: false,
		opacity: 1,
		props: {
			kind: 'arc',
			dash: 'draw',
			size: 'm',
			fill: 'none',
			color: 'orange',
			labelColor: 'black',
			bend: 0,
			start: { x: 0, y: 0 },
			end: { x: endDx, y: endDy },
			arrowheadStart: 'none',
			arrowheadEnd: 'arrow',
			font: 'draw',
			richText: toRichText(''),
			labelPosition: 0.5,
			scale: 1,
			elbowMidPoint: 0.5,
		},
		meta: {},
	}
}

/**
 * Called by POST /speech on each speech recognition result.
 * - isFinal=false: create or update an interim (semi-transparent) shape.
 * - isFinal=true: finalize the interim shape to full opacity and advance y-offset.
 */
export function writeSpeechToRoom(
	roomId: string,
	text: string,
	isFinal: boolean,
	clickX?: number,
	clickY?: number
): TLShapeId {
	const room = getOrCreateRoom(roomId)

	if (!isFinal) {
		let shapeId = interimShapeIds.get(roomId)
		if (!shapeId) {
			shapeId = createShapeId(uniqueId())
			interimShapeIds.set(roomId, shapeId)
			const { x, y } = nextPosition(roomId, clickX, clickY)
			const index = nextIndex(roomId)
			room.storage.transaction((txn) => {
				txn.set(shapeId!, makeTextShape(shapeId!, '🎤 ' + text, x, y, index, 0.45) as any)
			})
		} else {
			room.storage.transaction((txn) => {
				const existing = txn.get(shapeId! as string) as TLTextShape | undefined
				if (existing) {
					txn.set(shapeId!, {
						...existing,
						props: { ...existing.props, richText: toRichText('🎤 ' + text) },
					} as any)
				}
			})
		}
		return shapeId
	} else {
		const shapeId = interimShapeIds.get(roomId) ?? createShapeId(uniqueId())
		interimShapeIds.delete(roomId)
		room.storage.transaction((txn) => {
			const existing = txn.get(shapeId as string) as TLTextShape | undefined
			if (existing) {
				txn.set(shapeId, {
					...existing,
					opacity: 1,
					props: { ...existing.props, richText: toRichText(text) },
				} as any)
			} else {
				// No interim shape existed (e.g. speech jumped straight to final)
				const { x, y } = nextPosition(roomId, clickX, clickY)
				const index = nextIndex(roomId)
				txn.set(shapeId, makeTextShape(shapeId, text, x, y, index, 1) as any)
			}
		})
		return shapeId
	}
}

/**
 * Creates a placeholder shape for an agent response and returns its ID.
 * Called once when the agent starts streaming.
 */
export function createAgentShape(roomId: string, clickX?: number, clickY?: number): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())
	const { x, y } = nextPosition(roomId, clickX, clickY)
	const index = nextIndex(roomId)
	room.storage.transaction((txn) => {
		txn.set(shapeId, makeTextShape(shapeId, '🤖 …', x, y, index, 1) as any)
	})
	return shapeId
}

/**
 * Overwrites the accumulated text of an in-progress agent shape.
 * Called on each streaming token delta.
 */
export function updateAgentShape(roomId: string, shapeId: TLShapeId, text: string): void {
	const room = getOrCreateRoom(roomId)
	room.storage.transaction((txn) => {
		const existing = txn.get(shapeId as string) as TLTextShape | undefined
		if (existing) {
			txn.set(shapeId, {
				...existing,
				props: { ...existing.props, richText: toRichText('🤖 ' + text) },
			} as any)
		}
	})
}

export interface AnnotationResult {
	frameId: TLShapeId
	arrowId: TLShapeId
	summaryId: TLShapeId
}

/**
 * Creates a dashed geo frame + arrow + SummaryCard annotation around the given shape IDs.
 * summaryText is optional; a stub is shown when absent or when OpenAI is unavailable.
 */
export function createAnnotationShapes(
	roomId: string,
	shapeIds: TLShapeId[],
	summaryText?: string
): AnnotationResult | null {
	const room = getOrCreateRoom(roomId)
	if (shapeIds.length === 0) return null

	// ── 1. Read shapes & compute bounding box ──────────────────────────────
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity
	let foundCount = 0

	room.storage.transaction((txn) => {
		for (const id of shapeIds) {
			const shape = txn.get(id as string) as any
			if (!shape || shape.typeName !== 'shape') continue
			foundCount++
			const x: number = shape.x ?? 0
			const y: number = shape.y ?? 0
			const w: number = shape.props?.w ?? 200
			// Text shapes use autoSize so h is unknown server-side; use stack spacing as estimate
			const h: number = shape.props?.h ?? 130
			if (x < minX) minX = x
			if (y < minY) minY = y
			if (x + w > maxX) maxX = x + w
			if (y + h > maxY) maxY = y + h
		}
	})

	if (foundCount === 0) return null

	// ── 2. Derive layout ───────────────────────────────────────────────────
	const PAD = 20
	const GAP = 60 // gap between frame right edge and arrow start/summary

	const frameX = minX - PAD
	const frameY = minY - PAD
	const frameW = maxX - minX + PAD * 2
	const frameH = maxY - minY + PAD * 2

	// Arrow: from frame's right-center to summary card's left edge
	const arrowStartX = frameX + frameW
	const arrowStartY = frameY + frameH / 2
	const arrowDx = GAP

	// SummaryCard: placed at the arrow's end point
	const summaryX = arrowStartX + GAP
	const summaryY = frameY

	// ── 3. Build stub summary text ─────────────────────────────────────────
	const stub =
		summaryText ??
		`🗂 摘要（打桩）\n共选中 ${foundCount} 个形状\n\n此处将由 GPT-4o-mini 填充摘要内容`

	// ── 4. Write all three shapes in one transaction ───────────────────────
	const frameId = createShapeId(uniqueId())
	const arrowId = createShapeId(uniqueId())
	const summaryId = createShapeId(uniqueId())

	const frameIndex = nextIndex(roomId)
	const arrowIndex = nextIndex(roomId)
	const summaryIndex = nextIndex(roomId)

	room.storage.transaction((txn) => {
		txn.set(frameId, makeGeoShape(frameId, frameX, frameY, frameW, frameH, frameIndex) as any)
		txn.set(
			arrowId,
			makeArrowShape(arrowId, arrowStartX, arrowStartY, arrowDx, 0, arrowIndex) as any
		)
		txn.set(
			summaryId,
			makeTextShape(summaryId, stub, summaryX, summaryY, summaryIndex, 1, 'orange') as any
		)
	})

	return { frameId, arrowId, summaryId }
}

// ── Image shape helpers ───────────────────────────────────────────────────────

function makeImageAsset(
	id: TLAssetId,
	dataUrl: string, // full "data:<mime>;base64,..." URL
	w: number,
	h: number,
	mimeType: string
): TLImageAsset {
	return {
		id,
		typeName: 'asset',
		type: 'image',
		props: {
			w,
			h,
			name: 'screenshot.png',
			isAnimated: false,
			mimeType,
			src: dataUrl,
		},
		meta: {},
	}
}

function makeImageShape(
	id: TLShapeId,
	assetId: TLAssetId,
	x: number,
	y: number,
	w: number,
	h: number,
	index: IndexKey
): TLImageShape {
	// Scale down large screenshots to fit reasonably on the canvas
	const MAX_W = 640
	const scale = w > MAX_W ? MAX_W / w : 1
	const displayW = Math.round(w * scale)
	const displayH = Math.round(h * scale)

	return {
		id,
		typeName: 'shape',
		type: 'image',
		x,
		y,
		rotation: 0,
		index,
		parentId: 'page:page' as any,
		isLocked: false,
		opacity: 1,
		props: {
			assetId,
			w: displayW,
			h: displayH,
			playing: false,
			url: '',
			crop: null,
			flipX: false,
			flipY: false,
			altText: '',
		},
		meta: {},
	}
}

export interface ImageShapeResult {
	imageShapeId: TLShapeId
	agentShapeId: TLShapeId
	/** Display width of the image shape (after scale-down) */
	displayW: number
	/** Top-left position of the agent card (for placing OCR shape below it) */
	agentX: number
	agentY: number
}

/**
 * Creates a TLImageAsset + TLImageShape on the whiteboard, plus an agent placeholder
 * card positioned to the right of the image for streaming vision analysis.
 */
export function createImageShapeInRoom(
	roomId: string,
	base64: string, // raw base64, no data: prefix
	mimeType: string,
	srcW: number, // original pixel width
	srcH: number, // original pixel height
	clickX?: number,
	clickY?: number
): ImageShapeResult {
	const room = getOrCreateRoom(roomId)

	const { x, y } = nextPosition(roomId, clickX, clickY)
	const imageIndex = nextIndex(roomId)
	const agentIndex = nextIndex(roomId)

	const assetId = ('asset:' + uniqueId()) as TLAssetId
	const imageShapeId = createShapeId(uniqueId())
	const agentShapeId = createShapeId(uniqueId())

	const dataUrl = `data:${mimeType};base64,${base64}`

	// Scale display size
	const MAX_W = 640
	const scale = srcW > MAX_W ? MAX_W / srcW : 1
	const displayW = Math.round(srcW * scale)
	const displayH = Math.round(srcH * scale)

	// Agent card sits 20px to the right of the image
	const agentX = x + displayW + 20

	room.storage.transaction((txn) => {
		txn.set(assetId as string, makeImageAsset(assetId, dataUrl, srcW, srcH, mimeType) as any)
		txn.set(
			imageShapeId,
			makeImageShape(imageShapeId, assetId, x, y, srcW, srcH, imageIndex) as any
		)
		txn.set(
			agentShapeId,
			makeTextShape(agentShapeId, '🔍 分析中…', agentX, y, agentIndex, 1, 'violet', 200, 's') as any
		)
	})

	// Advance y offset past the image height so subsequent shapes don't overlap
	roomYOffsets.set(roomId, y + displayH + 30)

	return { imageShapeId, agentShapeId, displayW, agentX, agentY: y }
}

/**
 * Returns a concatenation of all text shape content in the room,
 * used as context for the vision model's analysis prompt.
 */
export function getRoomContextText(roomId: string): string {
	const room = rooms.get(roomId)
	if (!room) return ''

	const texts: string[] = []
	const docs = room.storage.getSnapshot().documents
	for (const doc of docs) {
		const record = doc.state as any
		if (record?.typeName !== 'shape') continue
		if (record.type !== 'text') continue
		const rich = record.props?.richText
		if (!rich) continue
		// richText is a ProseMirror-compatible JSON doc; extract plain text
		const plain = extractPlainText(rich)
		if (plain.trim()) texts.push(plain.trim())
	}
	return texts.join('\n')
}

function extractPlainText(richText: any): string {
	if (!richText || typeof richText !== 'object') return ''
	if (richText.type === 'text') return richText.text ?? ''
	if (Array.isArray(richText.content)) {
		return richText.content.map(extractPlainText).join('')
	}
	return ''
}

/**
 * Creates a secondary OCR text shape below the summary card.
 * Uses grey color, small font (size 's'), narrow width (200px).
 */
export function createOcrShape(roomId: string, x: number, y: number, ocrText: string): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())
	const index = nextIndex(roomId)
	room.storage.transaction((txn) => {
		txn.set(
			shapeId,
			makeTextShape(shapeId, '📝 ' + ocrText, x, y, index, 1, 'grey', 200, 's') as any
		)
	})
	return shapeId
}
