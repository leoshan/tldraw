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
	type TLImageAsset,
	type TLImageShape,
	type TLRecord,
	type TLShapeId,
	type TLTextShape,
} from 'tldraw'

const DATA_DIR = join(process.cwd(), 'data', 'rooms')
mkdirSync(DATA_DIR, { recursive: true })

// Prevent path traversal when building DB file paths
export function sanitizeRoomId(roomId: string): string {
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
// X anchor for speech text column — set on the first speech event (from a click or default),
// then never changed by subsequent clicks so text always left-aligns to the same column.
const roomSpeechAnchorX = new Map<string, number>()
// ④ Sliding window summary — char count since last trigger + rolling text buffer
const roomCharCount = new Map<string, number>()
const roomSpeechBuffer = new Map<string, string>()
// Active page ID per room — updated by clients when they switch pages
const roomActivePageId = new Map<string, string>()
// Per-room real shape bounds (page space), backfilled by the client after layout
// via editor.getShapePageBounds(). Used to place annotation/OCR/minutes shapes
// against true text dimensions instead of server-side estimates.
const roomShapeBounds = new Map<string, Map<string, ShapeBox>>()
// Rolling summary — track the active summary card ID so we update it in place
// instead of creating a new card each time the char threshold is met.
const roomActiveSummaryCardId = new Map<string, TLShapeId>()
// Timestamp of the last final speech result per room — used for VAD silence detection.
const roomLastSpeechTime = new Map<string, number>()

// ── Real text measurement ─────────────────────────────────────────────────────

/** A page-space bounding box for a shape. */
export interface ShapeBox {
	x: number
	y: number
	w: number
	h: number
}

/**
 * Backfill real, post-layout shape bounds reported by a client.
 * Replaces any existing entry for each id so the latest measurement wins.
 */
export function setShapeBounds(
	roomId: string,
	bounds: Array<{ id: string; x: number; y: number; w: number; h: number }>
): void {
	let map = roomShapeBounds.get(roomId)
	if (!map) {
		map = new Map()
		roomShapeBounds.set(roomId, map)
	}
	for (const b of bounds) {
		if (!b || typeof b.id !== 'string') continue
		if (![b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue
		map.set(b.id, { x: b.x, y: b.y, w: b.w, h: b.h })
	}
}

/** Returns the client-reported real bounds for a shape, or null if none reported. */
export function getShapeBounds(roomId: string, shapeId: string): ShapeBox | null {
	return roomShapeBounds.get(roomId)?.get(shapeId) ?? null
}

/** Drops all stored bounds for a room (e.g. when the room is unloaded). */
export function clearShapeBounds(roomId: string): void {
	roomShapeBounds.delete(roomId)
}

/** Approx font pixel size per tldraw text size token. */
const TEXT_FONT_SIZE: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }

/**
 * Estimated horizontal advance (px) of a single code point.
 * CJK ideographs, kana, hangul, full-width forms, and emoji occupy ~1 em;
 * Latin/ASCII characters ~0.55 em. Metric-free, but far closer to real layout
 * than a flat "chars per line" divisor for mixed Chinese/English text.
 */
function charAdvance(codePoint: number, fontSize: number): number {
	const isWide =
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals, kana, CJK unified ext
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // full-width forms
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) || // full-width signs
		codePoint >= 0x1f000 // emoji & supplementary symbols
	return isWide ? fontSize : fontSize * 0.55
}

export interface MeasureTextOptions {
	/** Available text width in canvas units (the shape's w). */
	width: number
	/** Effective font size in px (already multiplied by the shape scale). */
	fontSize: number
	/** Line height as a multiple of font size. */
	lineHeightFactor?: number
	/** Vertical + horizontal inner padding in px. */
	padding?: number
}

/**
 * Estimates the rendered height (px) of wrapped text, honouring explicit
 * newlines and per-character width so mixed CJK/Latin/emoji content wraps
 * realistically. Replaces the old `charCount / (w/16)` line estimate.
 */
export function measureTextHeight(text: string, opts: MeasureTextOptions): number {
	const { width, fontSize, lineHeightFactor = 1.3, padding = 8 } = opts
	const maxLineWidth = Math.max(1, width - padding * 2)
	let totalLines = 0
	for (const paragraph of text.split('\n')) {
		if (paragraph.length === 0) {
			totalLines += 1
			continue
		}
		let lineWidth = 0
		let lineCount = 1
		for (const ch of paragraph) {
			const adv = charAdvance(ch.codePointAt(0) ?? 0, fontSize)
			// Wrap when the glyph would overflow, but never on an empty line
			// (a single glyph wider than the box still occupies one line).
			if (lineWidth > 0 && lineWidth + adv > maxLineWidth) {
				lineCount += 1
				lineWidth = adv
			} else {
				lineWidth += adv
			}
		}
		totalLines += lineCount
	}
	return Math.ceil(totalLines * fontSize * lineHeightFactor + padding * 2)
}

/**
 * Resolves a shape's page-space box. Prefers real client-reported bounds; when
 * absent (e.g. a shape the server just created) falls back to measuring text
 * shapes and to the stored props.h / a default for everything else.
 */
export function resolveShapeBox(roomId: string, shape: any): ShapeBox {
	const real = getShapeBounds(roomId, shape.id)
	if (real) return real

	const x: number = shape.x ?? 0
	const y: number = shape.y ?? 0
	const w: number = shape.props?.w ?? 200
	let h: number = shape.props?.h ?? 130

	if (shape.type === 'text') {
		const rich = shape.props?.richText
		const text = rich ? extractPlainText(rich).trim() : ''
		const size = (shape.props?.size as string) ?? 'm'
		const scale = (shape.props?.scale as number) ?? 1
		const fontSize = (TEXT_FONT_SIZE[size] ?? 24) * scale
		h = measureTextHeight(text, { width: w, fontSize })
	}

	return { x, y, w, h }
}

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
					roomSpeechAnchorX.delete(roomId)
					roomCharCount.delete(roomId)
					roomSpeechBuffer.delete(roomId)
					roomActiveSummaryCardId.delete(roomId)
					roomLastSpeechTime.delete(roomId)
					clearShapeBounds(roomId)
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

// Gap between consecutive speech text shapes (single line ≈ 24 px, gap = 12 px).
const SPEECH_Y_STEP = 36

/**
 * Advance the room's Y cursor for a new speech shape.
 *
 * Rules:
 *  - X: anchored on the first speech event (from clickX or the current offset).
 *       Subsequent clicks never move the anchor, so all speech text stays in
 *       the same left column for the lifetime of the room session.
 *  - Y: always auto-stacks downward from the current cursor.
 *       The first speech event may jump the cursor to clickY if it is below
 *       the current position; after the anchor is established, clickY is ignored.
 *       Image inserts advance the cursor past their height automatically.
 */
function speechPosition(
	roomId: string,
	clickX?: number,
	clickY?: number
): { x: number; y: number } {
	const hasAnchor = roomSpeechAnchorX.has(roomId)

	if (!hasAnchor) {
		// First speech event — lock in the X anchor from the click or current offset.
		const anchorX = clickX ?? roomXOffsets.get(roomId) ?? 40
		roomSpeechAnchorX.set(roomId, anchorX)
		// Honour clickY only here, to let the user position the start of the block.
		if (clickY !== undefined) {
			const currentY = roomYOffsets.get(roomId) ?? 80
			if (clickY > currentY) roomYOffsets.set(roomId, clickY)
		}
	}
	// Use anchored X; ignore clickX / clickY from this point on.
	const anchorX = roomSpeechAnchorX.get(roomId)!
	const { x, y } = nextPosition(roomId, anchorX)
	// nextPosition advances Y by 130 (image-sized); override with the tighter speech step.
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
	clickY?: number,
	pageId?: string
): TLShapeId {
	const room = getOrCreateRoom(roomId)

	// Pin shapes to the recording page for the duration of this call.
	// All shape factories read roomActivePageId synchronously inside transactions,
	// so the temporary override is safe with no async between set and restore.
	const prevPage = roomActivePageId.get(roomId)
	const hadPage = roomActivePageId.has(roomId)
	if (pageId) roomActivePageId.set(roomId, pageId)

	try {
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
						makeTextShape(
							roomId,
							shapeId!,
							'🎤 ' + text,
							x,
							y,
							index,
							0.45,
							'grey',
							400,
							's'
						) as any
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
	} finally {
		// Restore the active page to whatever it was before this call.
		if (pageId) {
			if (hadPage) roomActivePageId.set(roomId, prevPage!)
			else roomActivePageId.delete(roomId)
		}
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
	arrowId: TLShapeId
	summaryId: TLShapeId
}

/**
 * Builds an id → record map from the room's current snapshot.
 * Shared read path so geometry and content extraction stay consistent.
 * Returns null when the room is not loaded.
 */
function getRoomDocMap(roomId: string): Map<string, any> | null {
	const room = rooms.get(roomId)
	if (!room) return null
	const docs = (room.storage as any).getSnapshot().documents
	return new Map<string, any>(docs.map((d: any) => [d.state.id, d.state]))
}

/**
 * Creates a right-pointing arrow + SummaryCard annotation for the given shape IDs.
 * The arrow starts at the top-right corner of the selection and extends outward;
 * the summary card follows at the arrow's end.
 * summaryText is optional; a stub is shown when absent or when OpenAI is unavailable.
 */
export function createAnnotationShapes(
	roomId: string,
	shapeIds: TLShapeId[],
	summaryText?: string
): AnnotationResult | null {
	const room = getOrCreateRoom(roomId)
	if (shapeIds.length === 0) return null

	// ── 1. Read shapes & compute bounding box (snapshot read, same as getSelectedContent) ──
	const docMap = getRoomDocMap(roomId)
	if (!docMap) return null

	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity
	let foundCount = 0

	for (const id of shapeIds) {
		const shape = docMap.get(id as string)
		if (!shape || shape.typeName !== 'shape') continue
		foundCount++

		// Prefer real client-measured bounds; fall back to text measurement so the
		// bounding box covers multi-line / mixed CJK content accurately.
		const { x, y, w, h } = resolveShapeBox(roomId, shape)

		if (x < minX) minX = x
		if (y < minY) minY = y
		if (x + w > maxX) maxX = x + w
		if (y + h > maxY) maxY = y + h
	}

	if (foundCount === 0) return null

	// ── 2. Derive layout: right arrow from the selection's top-right corner ──
	const GAP = 60 // arrow length / spacing from selection to summary card

	// Arrow starts at the top-right corner of the selection and points right
	const arrowStartX = maxX
	const arrowStartY = minY
	const arrowDx = GAP

	// SummaryCard: placed just past the arrow's end, top-aligned with the selection
	const summaryX = arrowStartX + arrowDx + 10
	const summaryY = minY

	// ── 3. Build stub summary text ─────────────────────────────────────────
	const stub =
		summaryText ??
		`🗂 摘要（打桩）\n共选中 ${foundCount} 个形状\n\n此处将由 GPT-4o-mini 填充摘要内容`

	// ── 4. Write arrow + summary in one transaction ────────────────────────
	const arrowId = createShapeId(uniqueId())
	const summaryId = createShapeId(uniqueId())

	const arrowIndex = nextIndex(roomId)
	const summaryIndex = nextIndex(roomId)

	room.storage.transaction((txn) => {
		txn.set(
			arrowId,
			makeArrowShape(roomId, arrowId, arrowStartX, arrowStartY, arrowDx, 0, arrowIndex) as any
		)
		txn.set(
			summaryId,
			makeTextShape(
				roomId,
				summaryId,
				stub,
				summaryX,
				summaryY,
				summaryIndex,
				1,
				'orange',
				320
			) as any
		)
	})

	return { arrowId, summaryId }
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
 * Minimum VAD silence duration (ms) that counts as a natural speech pause.
 * Summary only fires when both the char threshold AND this silence window have passed,
 * avoiding mid-sentence cuts.
 */
export const VAD_SILENCE_MS = 2000

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

/**
 * Records the timestamp of the most recent final speech result for a room.
 * Called after every final ASR result so the VAD silence window can be measured.
 */
export function markSpeechTime(roomId: string): void {
	roomLastSpeechTime.set(roomId, Date.now())
}

/**
 * Returns true when the room has been silent for at least VAD_SILENCE_MS milliseconds,
 * indicating a natural pause in speech. Always returns true when no speech has been
 * recorded yet (no prior speech time stored).
 */
export function isAtNaturalPause(roomId: string): boolean {
	const last = roomLastSpeechTime.get(roomId)
	if (last === undefined) return true
	return Date.now() - last >= VAD_SILENCE_MS
}

/**
 * Returns the ID of the active rolling summary card for this room, or null if none exists.
 */
export function getActiveSummaryCardId(roomId: string): TLShapeId | null {
	return roomActiveSummaryCardId.get(roomId) ?? null
}

/**
 * Sets the active rolling summary card ID for this room.
 * Pass null to clear it (forces the next summary to create a new card).
 */
export function setActiveSummaryCardId(roomId: string, shapeId: TLShapeId | null): void {
	if (shapeId === null) {
		roomActiveSummaryCardId.delete(roomId)
	} else {
		roomActiveSummaryCardId.set(roomId, shapeId)
	}
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
export function createSummaryCard(
	roomId: string,
	placeholderText: string,
	pageId?: string
): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())

	const prevPage = roomActivePageId.get(roomId)
	const hadPage = roomActivePageId.has(roomId)
	if (pageId) roomActivePageId.set(roomId, pageId)

	try {
		const { x, y } = nextPosition(roomId)
		const index = nextIndex(roomId)
		room.storage.transaction((txn) => {
			txn.set(
				shapeId,
				makeTextShape(roomId, shapeId, placeholderText, x, y, index, 1, 'orange', 600, 'm') as any
			)
		})
	} finally {
		if (pageId) {
			if (hadPage) roomActivePageId.set(roomId, prevPage!)
			else roomActivePageId.delete(roomId)
		}
	}

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

		// Prefer real client-measured bounds; fall back to text measurement so the
		// minutes card never overlaps the true bottom of existing content.
		const { y, h } = resolveShapeBox(roomId, record)
		const bottom = y + h
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
	const result: SelectedContent = { texts: [], images: [] }
	const docMap = getRoomDocMap(roomId)
	if (!docMap) return result

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

/**
 * Force-closes a room and wipes all in-memory state for it.
 * Returns the absolute path to the room's SQLite DB file so the caller
 * can delete it from disk (rooms.ts has no fs dependency by design).
 */
export function deleteRoom(roomId: string): string {
	const room = rooms.get(roomId)
	if (room && !room.isClosed()) room.close()

	const db = roomDbs.get(roomId)
	db?.close()

	rooms.delete(roomId)
	roomDbs.delete(roomId)
	roomXOffsets.delete(roomId)
	roomYOffsets.delete(roomId)
	roomLastIndex.delete(roomId)
	interimShapeIds.delete(roomId)
	roomImageColumnX.delete(roomId)
	roomSpeechAnchorX.delete(roomId)
	roomCharCount.delete(roomId)
	roomSpeechBuffer.delete(roomId)
	roomActivePageId.delete(roomId)
	roomActiveSummaryCardId.delete(roomId)
	roomLastSpeechTime.delete(roomId)

	return join(DATA_DIR, `${sanitizeRoomId(roomId)}.db`)
}
