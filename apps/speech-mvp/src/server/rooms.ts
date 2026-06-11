import { mkdirSync } from 'fs'
import { join } from 'path'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { getIndexAbove, IndexKey, uniqueId } from '@tldraw/utils'
import Database from 'better-sqlite3'
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

const DATA_DIR = join(process.cwd(), 'data', 'rooms')
mkdirSync(DATA_DIR, { recursive: true })

// Prevent path traversal when building DB file paths
function sanitizeRoomId(roomId: string): string {
	return roomId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

const rooms = new Map<string, TLSocketRoom<TLRecord, void>>()
const roomDbs = new Map<string, InstanceType<typeof Database>>()
// Per-room position tracking for stacking shapes
const roomXOffsets = new Map<string, number>()
const roomYOffsets = new Map<string, number>()
// Per-room last used IndexKey for fractional indexing
const roomLastIndex = new Map<string, IndexKey>()
// Per-room in-progress interim speech shape
const interimShapeIds = new Map<string, TLShapeId>()
// X anchor for the image column — set on first image, reused for all subsequent images
// so every screenshot/upload aligns to the same left edge regardless of viewport scroll.
const roomImageColumnX = new Map<string, number>()
// ④ Sliding window summary — char count since last trigger + rolling text buffer
const roomCharCount = new Map<string, number>()
const roomSpeechBuffer = new Map<string, string>()
// Active page ID per room — updated by clients when they switch pages
const roomActivePageId = new Map<string, string>()

// ── SQLite helpers ────────────────────────────────────────────────────────────

function initCustomTables(db: InstanceType<typeof Database>): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS speech_mvp_offsets (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS speech_mvp_checkpoints (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			name       TEXT    NOT NULL,
			snapshot   TEXT    NOT NULL,
			created_at INTEGER NOT NULL
		);
	`)
}

function loadOffsets(db: InstanceType<typeof Database>): { x: number; y: number; index: IndexKey } {
	const stmt = db.prepare('SELECT value FROM speech_mvp_offsets WHERE key = ?')
	const get = (key: string) => (stmt.get(key) as { value: string } | undefined)?.value
	return {
		x: Number(get('x') ?? '40'),
		y: Number(get('y') ?? '80'),
		index: (get('index') ?? 'a0') as IndexKey,
	}
}

function persistOffsets(
	db: InstanceType<typeof Database>,
	x: number,
	y: number,
	index: IndexKey
): void {
	const stmt = db.prepare('INSERT OR REPLACE INTO speech_mvp_offsets (key, value) VALUES (?, ?)')
	stmt.run('x', String(x))
	stmt.run('y', String(y))
	stmt.run('index', index)
}

export function getOrCreateRoom(roomId: string): TLSocketRoom<TLRecord, void> {
	const existing = rooms.get(roomId)
	if (existing && !existing.isClosed()) return existing

	const safeId = sanitizeRoomId(roomId)
	const db = new Database(join(DATA_DIR, `${safeId}.db`))
	db.pragma('journal_mode = WAL')
	initCustomTables(db)

	// Load previously saved offsets (or use defaults for brand-new rooms)
	const { x, y, index } = loadOffsets(db)
	roomXOffsets.set(roomId, x)
	roomYOffsets.set(roomId, y)
	roomLastIndex.set(roomId, index)
	roomDbs.set(roomId, db)

	const sql = new NodeSqliteWrapper(db)
	const storage = new SQLiteSyncStorage<TLRecord>({ sql })

	const room = new TLSocketRoom<TLRecord, void>({
		storage,
		schema: createTLSchema() as any,
		onSessionRemoved(room, { numSessionsRemaining }) {
			if (numSessionsRemaining === 0) {
				setTimeout(() => {
					if (room.isClosed()) return
					// Persist current offsets so the next room load resumes from the right position
					const roomDb = roomDbs.get(roomId)
					if (roomDb) {
						persistOffsets(
							roomDb,
							roomXOffsets.get(roomId) ?? 40,
							roomYOffsets.get(roomId) ?? 80,
							roomLastIndex.get(roomId) ?? ('a0' as IndexKey)
						)
					}
					room.close()
					roomDb?.close()
					rooms.delete(roomId)
					roomDbs.delete(roomId)
					roomXOffsets.delete(roomId)
					roomYOffsets.delete(roomId)
					roomLastIndex.delete(roomId)
					interimShapeIds.delete(roomId)
					roomImageColumnX.delete(roomId)
					roomCharCount.delete(roomId)
					roomSpeechBuffer.delete(roomId)
				}, 10_000)
			}
		},
	})

	rooms.set(roomId, room)
	return room
}

/**
 * Returns the X column anchor for images in this room.
 * On the first call for a room, stores initialX as the anchor; subsequent calls
 * return the stored value so every image lands in the same column.
 */
export function getOrSetImageColumnX(roomId: string, initialX: number): number {
	if (!roomImageColumnX.has(roomId)) {
		roomImageColumnX.set(roomId, initialX)
	}
	return roomImageColumnX.get(roomId)!
}

function activePage(roomId: string): any {
	return (roomActivePageId.get(roomId) ?? 'page:page') as any
}

export function setRoomActivePage(roomId: string, pageId: string): void {
	roomActivePageId.set(roomId, pageId)
}

function nextPosition(
	roomId: string,
	overrideX?: number,
	overrideY?: number
): { x: number; y: number } {
	// X and Y are independent: each falls back to its tracked offset when not overridden.
	// This lets callers pin only X (viewport alignment) while Y auto-stacks below previous content.
	const x = overrideX !== undefined ? overrideX : (roomXOffsets.get(roomId) ?? 40)
	const y = overrideY !== undefined ? overrideY : (roomYOffsets.get(roomId) ?? 80)
	roomXOffsets.set(roomId, x)
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
	roomId: string,
	id: TLShapeId,
	text: string,
	x: number,
	y: number,
	index: IndexKey,
	opacity: number,
	color: TLTextShape['props']['color'] = 'black',
	w = 400,
	size: TLTextShape['props']['size'] = 'm',
	scale = 1,
	autoSize = true
): TLTextShape {
	return {
		id,
		typeName: 'shape',
		type: 'text',
		x,
		y,
		rotation: 0,
		index,
		parentId: activePage(roomId),
		isLocked: false,
		opacity,
		props: {
			color,
			size,
			font: 'serif',
			textAlign: 'start',
			w,
			richText: toRichText(text),
			scale,
			autoSize,
		},
		meta: {},
	}
}

function makeGeoShape(
	roomId: string,
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
		parentId: activePage(roomId),
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
	roomId: string,
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
		parentId: activePage(roomId),
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

// Gap between consecutive speech text shapes (single line ≈ 30 px, gap = 20 px).
const SPEECH_Y_STEP = 50

/**
 * Advance the room's Y cursor for a new speech shape.
 *
 * Rules:
 *  - X: use clickX for left-column alignment (stored in roomXOffsets).
 *  - Y: always auto-stack from the current roomYOffsets cursor.
 *       If clickY is provided and is BELOW the current cursor, jump down
 *       to that position first (lets the user anchor a new speech block lower
 *       on the canvas). Never jump upward — that would cause overlap.
 */
function speechPosition(
	roomId: string,
	clickX?: number,
	clickY?: number
): { x: number; y: number } {
	if (clickY !== undefined) {
		const currentY = roomYOffsets.get(roomId) ?? 80
		if (clickY > currentY) roomYOffsets.set(roomId, clickY)
	}
	// Only override X; Y comes from the accumulated roomYOffsets cursor.
	const { x, y } = nextPosition(roomId, clickX)
	// nextPosition advances by 130 (suitable for images); tighten for speech text.
	roomYOffsets.set(roomId, y + SPEECH_Y_STEP)
	return { x, y }
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
			const { x, y } = speechPosition(roomId, clickX, clickY)
			const index = nextIndex(roomId)
			room.storage.transaction((txn) => {
				txn.set(
					shapeId!,
					makeTextShape(roomId, shapeId!, '🎤 ' + text, x, y, index, 0.45, 'grey', 400, 's') as any
				)
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
				// Interim shape already placed — just finalize opacity and text.
				txn.set(shapeId, {
					...existing,
					opacity: 1,
					props: { ...existing.props, richText: toRichText(text) },
				} as any)
			} else {
				// No interim shape existed (speech jumped straight to final, e.g. system audio).
				const { x, y } = speechPosition(roomId, clickX, clickY)
				const index = nextIndex(roomId)
				txn.set(
					shapeId,
					makeTextShape(roomId, shapeId, text, x, y, index, 1, 'grey', 400, 's') as any
				)
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
		txn.set(shapeId, makeTextShape(roomId, shapeId, '🤖 …', x, y, index, 1) as any)
	})
	return shapeId
}

/**
 * Overwrites the accumulated text of an in-progress agent shape.
 * Automatically prepends the 🤖 prefix. For vision shapes use updateShapeText.
 */
export function updateAgentShape(roomId: string, shapeId: TLShapeId, text: string): void {
	updateShapeText(roomId, shapeId, '🤖 ' + text)
}

/** Overwrites shape text verbatim (no prefix added). */
export function updateShapeText(roomId: string, shapeId: TLShapeId, text: string): void {
	const room = getOrCreateRoom(roomId)
	room.storage.transaction((txn) => {
		const existing = txn.get(shapeId as string) as TLTextShape | undefined
		if (existing) {
			txn.set(shapeId, {
				...existing,
				props: { ...existing.props, richText: toRichText(text) },
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
		txn.set(
			frameId,
			makeGeoShape(roomId, frameId, frameX, frameY, frameW, frameH, frameIndex) as any
		)
		txn.set(
			arrowId,
			makeArrowShape(roomId, arrowId, arrowStartX, arrowStartY, arrowDx, 0, arrowIndex) as any
		)
		txn.set(
			summaryId,
			makeTextShape(roomId, summaryId, stub, summaryX, summaryY, summaryIndex, 1, 'orange') as any
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
	roomId: string,
	id: TLShapeId,
	assetId: TLAssetId,
	x: number,
	y: number,
	w: number,
	h: number,
	index: IndexKey,
	targetW = 640
): TLImageShape {
	const scale = w > targetW ? targetW / w : 1
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
		parentId: activePage(roomId),
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
 *
 * @param targetDisplayW - max image display width in canvas units (default 640).
 *   When viewport info is available the caller passes vpW*2/3 so the image fills
 *   the left two-thirds of the visible canvas.
 * @param summaryOverrideX - explicit X for the summary card; when omitted defaults
 *   to image_right + 20.
 * @param summaryOverrideW - width of the summary card (default 260).
 */
export function createImageShapeInRoom(
	roomId: string,
	base64: string, // raw base64, no data: prefix
	mimeType: string,
	srcW: number, // original pixel width
	srcH: number, // original pixel height
	clickX?: number,
	clickY?: number,
	targetDisplayW?: number,
	summaryOverrideX?: number,
	summaryOverrideW = 260
): ImageShapeResult {
	const room = getOrCreateRoom(roomId)

	const { x, y } = nextPosition(roomId, clickX, clickY)
	const imageIndex = nextIndex(roomId)
	const agentIndex = nextIndex(roomId)

	const assetId = ('asset:' + uniqueId()) as TLAssetId
	const imageShapeId = createShapeId(uniqueId())
	const agentShapeId = createShapeId(uniqueId())

	const dataUrl = `data:${mimeType};base64,${base64}`

	const targetW = targetDisplayW ?? 640
	const imgScale = srcW > targetW ? targetW / srcW : 1
	const displayW = Math.round(srcW * imgScale)
	const displayH = Math.round(srcH * imgScale)

	const agentX = summaryOverrideX ?? x + displayW + 20

	room.storage.transaction((txn) => {
		txn.set(assetId as string, makeImageAsset(assetId, dataUrl, srcW, srcH, mimeType) as any)
		txn.set(
			imageShapeId,
			makeImageShape(roomId, imageShapeId, assetId, x, y, srcW, srcH, imageIndex, targetW) as any
		)
		txn.set(
			agentShapeId,
			makeTextShape(
				roomId,
				agentShapeId,
				'🔍 分析中…',
				agentX,
				y,
				agentIndex,
				1,
				'violet',
				Math.max(summaryOverrideW, 320),
				's',
				1,
				false
			) as any
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
	const docs = (room.storage as any).getSnapshot().documents
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
 * Uses grey color, small font (size 's') at half scale, matching the summary card style.
 *
 * @param w - card width in canvas units (should match summary card width)
 */
export function createOcrShape(
	roomId: string,
	x: number,
	y: number,
	ocrText: string,
	w = 260
): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())
	const index = nextIndex(roomId)
	room.storage.transaction((txn) => {
		txn.set(
			shapeId,
			makeTextShape(
				roomId,
				shapeId,
				'📝 ' + ocrText,
				x,
				y,
				index,
				1,
				'grey',
				w,
				's',
				0.5,
				false
			) as any
		)
	})
	return shapeId
}

// ── ④ Sliding window summary helpers ─────────────────────────────────────────

/**
 * Number of characters to accumulate before triggering a sliding window summary.
 * Chinese prose averages ~150–200 chars/minute, so 300 chars ≈ 1.5–2 minutes.
 */
export const SUMMARY_CHAR_THRESHOLD = 300

/**
 * Records a final speech text in the per-room buffer and increments the char counter.
 * Returns the updated count and the rolling window text for the summary prompt.
 * Called by both /speech (Web Speech API) and /transcribe (Whisper/SenseVoice).
 */
export function trackSpeechText(
	roomId: string,
	text: string
): { charCount: number; windowText: string } {
	const trimmed = text.trim()
	const count = (roomCharCount.get(roomId) ?? 0) + trimmed.length
	roomCharCount.set(roomId, count)

	// Rolling buffer — keep last ~2000 chars so the summary prompt stays concise
	const prev = roomSpeechBuffer.get(roomId) ?? ''
	const next = (prev + '\n' + trimmed).slice(-2000).trimStart()
	roomSpeechBuffer.set(roomId, next)

	return { charCount: count, windowText: next }
}

/** Resets the char counter and clears the speech buffer after a summary is triggered. */
export function resetCharCount(roomId: string): void {
	roomCharCount.set(roomId, 0)
	roomSpeechBuffer.set(roomId, '')
}

// ── Snapshot & checkpoint API ─────────────────────────────────────────────────

export interface CheckpointMeta {
	id: number
	name: string
	createdAt: number
}

/**
 * Returns the room's current canvas state as a StoreSnapshot compatible with
 * editor.loadSnapshot(). Returns null if the room is not loaded.
 */
export function getRoomSnapshot(roomId: string): object | null {
	const room = rooms.get(roomId)
	if (!room || room.isClosed()) return null
	const snap = (room.storage as any).getSnapshot()
	const schema = typeof snap.schema === 'string' ? JSON.parse(snap.schema || '{}') : snap.schema
	return {
		store: Object.fromEntries(snap.documents.map((d: any) => [d.state.id, d.state])),
		schema,
	}
}

/**
 * Saves a named checkpoint of the current room state to the room's SQLite DB.
 */
export function saveCheckpoint(roomId: string, name: string): CheckpointMeta | null {
	const room = rooms.get(roomId)
	const db = roomDbs.get(roomId)
	if (!room || room.isClosed() || !db) return null
	const snapshot = JSON.stringify((room.storage as any).getSnapshot())
	const createdAt = Date.now()
	const result = db
		.prepare('INSERT INTO speech_mvp_checkpoints (name, snapshot, created_at) VALUES (?, ?, ?)')
		.run(name, snapshot, createdAt)
	return { id: result.lastInsertRowid as number, name, createdAt }
}

/**
 * Lists all saved checkpoints for a room, newest first.
 */
export function listCheckpoints(roomId: string): CheckpointMeta[] {
	const db = roomDbs.get(roomId)
	if (!db) return []
	return db
		.prepare(
			'SELECT id, name, created_at as createdAt FROM speech_mvp_checkpoints ORDER BY created_at DESC'
		)
		.all() as CheckpointMeta[]
}

/**
 * Returns the canvas snapshot stored in a specific checkpoint as a StoreSnapshot
 * compatible with editor.loadSnapshot().
 */
export function loadCheckpointSnapshot(roomId: string, checkpointId: number): object | null {
	const db = roomDbs.get(roomId)
	if (!db) return null
	const row = db
		.prepare('SELECT snapshot FROM speech_mvp_checkpoints WHERE id = ?')
		.get(checkpointId) as { snapshot: string } | undefined
	if (!row) return null
	const snap = JSON.parse(row.snapshot)
	const schema = typeof snap.schema === 'string' ? JSON.parse(snap.schema || '{}') : snap.schema
	return {
		store: Object.fromEntries(snap.documents.map((d: any) => [d.state.id, d.state])),
		schema,
	}
}

/**
 * Creates an orange SummaryCard shape (sliding window summary result) in the normal
 * content flow. Returns the shape ID so the caller can stream the final text into it.
 */
export function createSummaryCard(roomId: string, placeholderText: string): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())
	const { x, y } = nextPosition(roomId)
	const index = nextIndex(roomId)
	room.storage.transaction((txn) => {
		txn.set(
			shapeId,
			makeTextShape(roomId, shapeId, placeholderText, x, y, index, 1, 'orange', 600, 'm') as any
		)
	})
	return shapeId
}

/**
 * Extracts all orange SummaryCards on the specified page of a room, sorted chronologically.
 */
export function getRoomSummaries(roomId: string, targetPageId?: string): string[] {
	const room = rooms.get(roomId)
	if (!room) return []

	const pageId = targetPageId || roomActivePageId.get(roomId) || 'page:page'
	const summaries: { text: string; y: number; index: string }[] = []

	const docs = (room.storage as any).getSnapshot().documents
	for (const doc of docs) {
		const record = doc.state as any
		if (record?.typeName !== 'shape') continue
		if (record.type !== 'text') continue
		if (record.parentId !== pageId) continue
		if (record.props?.color !== 'orange') continue

		const rich = record.props?.richText
		if (!rich) continue
		const plain = extractPlainText(rich).trim()
		if (plain) {
			summaries.push({
				text: plain,
				y: record.y ?? 0,
				index: record.index ?? '',
			})
		}
	}

	summaries.sort((a, b) => {
		if (a.index && b.index) {
			return a.index.localeCompare(b.index)
		}
		return a.y - b.y
	})

	return summaries.map((s) => s.text)
}

/**
 * Creates a large blue MinutesCard shape (meeting minutes result) on the specified page.
 * Returns the shape ID so the caller can stream the text into it.
 */
export function createMinutesCard(
	roomId: string,
	pageId: string,
	placeholderText: string
): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())

	// Find the maximum bottom coordinate of all shapes on the target page
	const docs = (room.storage as any).getSnapshot().documents
	let maxY = 40 // Default initial Y
	for (const doc of docs) {
		const record = doc.state as any
		if (record?.typeName !== 'shape') continue
		if (record.parentId !== pageId) continue

		const y = record.y ?? 0
		let height = 120 // Default estimate height
		if (record.props?.h) {
			height = record.props.h
		} else if (record.props?.size === 's') {
			height = 80
		} else if (record.props?.size === 'l') {
			height = 200
		}

		const bottom = y + height
		if (bottom > maxY) {
			maxY = bottom
		}
	}

	const x = 40 // Align with the left side column of speech/summaries
	const y = maxY + 60 // Place it 60px below the lowest shape
	const index = nextIndex(roomId)

	room.storage.transaction((txn) => {
		const shape = makeTextShape(
			roomId,
			shapeId,
			placeholderText,
			x,
			y,
			index,
			1,
			'blue',
			800,
			'm',
			1,
			false
		)
		shape.parentId = pageId as any
		txn.set(shapeId, shape as any)
	})

	// Update the vertical room offsets so subsequent speech card stack continues below this minutes card
	roomYOffsets.set(roomId, y + 250)

	return shapeId
}

export interface SelectedContent {
	texts: string[]
	images: { base64: string; mime: string }[]
}

/**
 * Extracts all plain texts and base64 image data URLs from selected shape IDs.
 */
export function getSelectedContent(roomId: string, shapeIds: TLShapeId[]): SelectedContent {
	const room = rooms.get(roomId)
	const result: SelectedContent = { texts: [], images: [] }
	if (!room) return result

	const docs = (room.storage as any).getSnapshot().documents
	const docMap = new Map<string, any>(docs.map((d: any) => [d.state.id, d.state]))

	for (const id of shapeIds) {
		const shape = docMap.get(id as string)
		if (!shape || shape.typeName !== 'shape') continue

		if (shape.type === 'text') {
			const rich = shape.props?.richText
			if (rich) {
				const plain = extractPlainText(rich).trim()
				if (plain) result.texts.push(plain)
			}
		} else if (shape.type === 'image') {
			const assetId = shape.props?.assetId
			if (assetId) {
				const asset = docMap.get(assetId as string)
				if (asset && asset.props?.src && asset.props?.mimeType) {
					result.images.push({
						base64: asset.props.src,
						mime: asset.props.mimeType,
					})
				}
			}
		}
	}

	return result
}
