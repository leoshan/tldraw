import { describe, expect, it } from 'vitest'
import {
	getShapeBounds,
	measureTextHeight,
	resolveShapeBox,
	setShapeBounds,
	clearShapeBounds,
} from './rooms'

// Minimal richText (ProseMirror-compatible) builder matching what the room stores.
function richText(text: string) {
	return {
		type: 'doc',
		content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
	}
}

describe('measureTextHeight', () => {
	it('grows with the number of explicit lines', () => {
		const one = measureTextHeight('a', { width: 400, fontSize: 24 })
		const three = measureTextHeight('a\nb\nc', { width: 400, fontSize: 24 })
		expect(three).toBeGreaterThan(one)
		// roughly 3x the single-line content height (padding is shared)
		expect(three).toBeGreaterThan(one * 2)
	})

	it('wraps long CJK text into multiple lines', () => {
		const short = measureTextHeight('短文本', { width: 200, fontSize: 24 })
		const long = measureTextHeight('这是一段非常长的中文文本'.repeat(8), {
			width: 200,
			fontSize: 24,
		})
		expect(long).toBeGreaterThan(short)
	})

	it('treats CJK glyphs as wider than ASCII for the same char count', () => {
		const ascii = measureTextHeight('a'.repeat(40), { width: 200, fontSize: 24 })
		const cjk = measureTextHeight('字'.repeat(40), { width: 200, fontSize: 24 })
		// Same count of characters, but CJK wraps onto more lines → taller.
		expect(cjk).toBeGreaterThan(ascii)
	})

	it('scales with font size', () => {
		const small = measureTextHeight('混排 mixed text', { width: 300, fontSize: 18 })
		const large = measureTextHeight('混排 mixed text', { width: 300, fontSize: 44 })
		expect(large).toBeGreaterThan(small)
	})

	it('counts blank lines', () => {
		const withGap = measureTextHeight('a\n\nb', { width: 400, fontSize: 24 })
		const noGap = measureTextHeight('a\nb', { width: 400, fontSize: 24 })
		expect(withGap).toBeGreaterThan(noGap)
	})
})

describe('shape bounds registry', () => {
	it('stores and returns client-reported bounds', () => {
		const room = 'test-bounds-1'
		clearShapeBounds(room)
		expect(getShapeBounds(room, 'shape:a')).toBeNull()
		setShapeBounds(room, [{ id: 'shape:a', x: 10, y: 20, w: 100, h: 80 }])
		expect(getShapeBounds(room, 'shape:a')).toEqual({ x: 10, y: 20, w: 100, h: 80 })
	})

	it('overwrites stale bounds with the latest measurement', () => {
		const room = 'test-bounds-2'
		clearShapeBounds(room)
		setShapeBounds(room, [{ id: 'shape:a', x: 0, y: 0, w: 100, h: 50 }])
		setShapeBounds(room, [{ id: 'shape:a', x: 0, y: 0, w: 100, h: 120 }])
		expect(getShapeBounds(room, 'shape:a')?.h).toBe(120)
	})

	it('ignores malformed entries', () => {
		const room = 'test-bounds-3'
		clearShapeBounds(room)
		setShapeBounds(room, [
			{ id: 'shape:ok', x: 1, y: 2, w: 3, h: 4 },
			{ id: 'shape:bad', x: NaN, y: 0, w: 10, h: 10 } as any,
			{ x: 0, y: 0, w: 1, h: 1 } as any,
		])
		expect(getShapeBounds(room, 'shape:ok')).toEqual({ x: 1, y: 2, w: 3, h: 4 })
		expect(getShapeBounds(room, 'shape:bad')).toBeNull()
	})

	it('clears bounds for a room', () => {
		const room = 'test-bounds-4'
		setShapeBounds(room, [{ id: 'shape:a', x: 0, y: 0, w: 1, h: 1 }])
		clearShapeBounds(room)
		expect(getShapeBounds(room, 'shape:a')).toBeNull()
	})
})

describe('resolveShapeBox', () => {
	it('prefers real client bounds over text measurement', () => {
		const room = 'test-resolve-1'
		clearShapeBounds(room)
		const shape = {
			id: 'shape:t',
			type: 'text',
			x: 5,
			y: 6,
			props: { w: 320, size: 'm', scale: 1, richText: richText('一些文字') },
		}
		setShapeBounds(room, [{ id: 'shape:t', x: 5, y: 6, w: 320, h: 999 }])
		expect(resolveShapeBox(room, shape).h).toBe(999)
	})

	it('measures text when no real bounds are available', () => {
		const room = 'test-resolve-2'
		clearShapeBounds(room)
		const short = {
			id: 'shape:s',
			type: 'text',
			x: 0,
			y: 0,
			props: { w: 200, size: 'm', scale: 1, richText: richText('短') },
		}
		const long = {
			id: 'shape:l',
			type: 'text',
			x: 0,
			y: 0,
			props: { w: 200, size: 'm', scale: 1, richText: richText('很长的中文内容'.repeat(10)) },
		}
		expect(resolveShapeBox(room, long).h).toBeGreaterThan(resolveShapeBox(room, short).h)
	})

	it('falls back to props.h for non-text shapes', () => {
		const room = 'test-resolve-3'
		clearShapeBounds(room)
		const image = { id: 'shape:i', type: 'image', x: 0, y: 0, props: { w: 640, h: 480 } }
		expect(resolveShapeBox(room, image)).toEqual({ x: 0, y: 0, w: 640, h: 480 })
	})
})
