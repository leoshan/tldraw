import { InMemorySyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { getIndexAbove, IndexKey, uniqueId } from '@tldraw/utils'
import {
	createShapeId,
	createTLSchema,
	toRichText,
	type TLRecord,
	type TLShapeId,
	type TLTextShape,
} from 'tldraw'

const rooms = new Map<string, TLSocketRoom<TLRecord, void>>()
// Per-room counter for y-position stacking
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
					roomYOffsets.delete(roomId)
					roomLastIndex.delete(roomId)
					interimShapeIds.delete(roomId)
				}, 10_000)
			}
		},
	})

	rooms.set(roomId, room)
	roomYOffsets.set(roomId, 80)
	return room
}

function nextY(roomId: string): number {
	const y = roomYOffsets.get(roomId) ?? 80
	roomYOffsets.set(roomId, y + 130)
	return y
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
	opacity: number
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
			color: 'black',
			size: 'm',
			font: 'draw',
			textAlign: 'start',
			w: 680,
			richText: toRichText(text),
			scale: 1,
			autoSize: true,
		},
		meta: {},
	}
}

/**
 * Called by POST /speech on each speech recognition result.
 * - isFinal=false: create or update an interim (semi-transparent) shape.
 * - isFinal=true: finalize the interim shape to full opacity and advance y-offset.
 */
export function writeSpeechToRoom(roomId: string, text: string, isFinal: boolean): TLShapeId {
	const room = getOrCreateRoom(roomId)

	if (!isFinal) {
		let shapeId = interimShapeIds.get(roomId)
		if (!shapeId) {
			shapeId = createShapeId(uniqueId())
			interimShapeIds.set(roomId, shapeId)
			const y = nextY(roomId)
			const index = nextIndex(roomId)
			room.storage.transaction((txn) => {
				txn.set(shapeId!, makeTextShape(shapeId!, '🎤 ' + text, 40, y, index, 0.45) as any)
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
				const y = nextY(roomId)
				const index = nextIndex(roomId)
				txn.set(shapeId, makeTextShape(shapeId, text, 40, y, index, 1) as any)
			}
		})
		return shapeId
	}
}

/**
 * Creates a placeholder shape for an agent response and returns its ID.
 * Called once when the agent starts streaming.
 */
export function createAgentShape(roomId: string): TLShapeId {
	const room = getOrCreateRoom(roomId)
	const shapeId = createShapeId(uniqueId())
	const y = nextY(roomId)
	const index = nextIndex(roomId)
	room.storage.transaction((txn) => {
		txn.set(shapeId, makeTextShape(shapeId, '🤖 …', 40, y, index, 1) as any)
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
