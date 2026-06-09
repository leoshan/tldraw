/**
 * Append-only JSONL transcript storage.
 *
 * Each final speech result is written as one JSON line to
 *   transcripts/{roomId}.jsonl
 *
 * GET /transcript/:roomId returns the file as a downloadable attachment.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'

export interface TranscriptEntry {
	ts: number // Unix ms timestamp
	text: string // full display text (may include emoji prefix)
	x: number // canvas x at time of writing
	y: number // canvas y at time of writing
}

const TRANSCRIPTS_DIR = resolve(process.cwd(), 'transcripts')

function ensureDir(): void {
	if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
}

function roomPath(roomId: string): string {
	// Sanitise roomId to a safe filename component
	const safe = roomId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
	return resolve(TRANSCRIPTS_DIR, `${safe}.jsonl`)
}

/** Appends a single transcript entry to the room's JSONL file (sync, small write). */
export function appendTranscript(roomId: string, text: string, x: number, y: number): void {
	ensureDir()
	const entry: TranscriptEntry = { ts: Date.now(), text, x, y }
	appendFileSync(roomPath(roomId), JSON.stringify(entry) + '\n', 'utf8')
}

/** Returns the absolute path to the transcript file, or null if it doesn't exist yet. */
export function getTranscriptFilePath(roomId: string): string | null {
	const p = roomPath(roomId)
	return existsSync(p) ? p : null
}
