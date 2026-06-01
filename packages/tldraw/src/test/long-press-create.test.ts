import { createShapeId } from '@tldraw/editor'
import { vi } from 'vitest'
import { TestEditor } from './TestEditor'

let editor: TestEditor

beforeEach(() => {
	editor = new TestEditor()
})
afterEach(() => {
	editor?.dispose()
})

vi.useFakeTimers()

// On a touch device a long press fires the browser `contextmenu` event. Each
// shape-creation tool should respond to the long press by canceling any pending
// creation, so the context menu opens with no stray shape left behind. The
// guard is `isCoarsePointer`, so fine-pointer (desktop) behavior must be
// preserved. See #8277.
//
// This branch implements two designs, switched by the `contextMenuMode` query
// param, so they can be compared:
//   - 'tool' (default): cancel and stay in the current tool.
//   - 'select': cancel, switch to the select tool, and select the shape under
//     the pointer so the menu carries the full set of shape actions.
const CREATION_TOOLS = [
	{ tool: 'geo', pointingState: 'geo.pointing' },
	{ tool: 'note', pointingState: 'note.pointing' },
	{ tool: 'text', pointingState: 'text.pointing' },
	{ tool: 'line', pointingState: 'line.pointing' },
	{ tool: 'arrow', pointingState: 'arrow.pointing' },
	{ tool: 'draw', pointingState: 'draw.drawing' },
	{ tool: 'frame', pointingState: 'frame.pointing' },
] as const

function setContextMenuMode(mode: 'tool' | 'tool-select' | 'select') {
	const search = mode === 'tool' ? '' : `?contextMenuMode=${mode}`
	window.history.replaceState(null, '', `/${search}`)
}

afterEach(() => {
	window.history.replaceState(null, '', '/')
})

describe('long press on shape-creation tools', () => {
	describe('with a coarse pointer, contextMenuMode=tool (default)', () => {
		beforeEach(() => {
			setContextMenuMode('tool')
			editor.updateInstanceState({ isCoarsePointer: true })
		})

		it.each(CREATION_TOOLS)(
			'$tool cancels creation and returns to its own idle, leaving no shape behind',
			({ tool }) => {
				editor.setCurrentTool(tool)
				editor.pointerDown(100, 100)
				vi.advanceTimersByTime(editor.options.longPressDurationMs)

				// stays in the active tool — the menu opens via the browser
				editor.expectToBeIn(`${tool}.idle`)
				expect(editor.getCurrentPageShapes()).toHaveLength(0)

				// releasing the long press must not create a shape either
				editor.pointerUp(100, 100)
				expect(editor.getCurrentPageShapes()).toHaveLength(0)
			}
		)
	})

	describe('with a coarse pointer, contextMenuMode=select', () => {
		beforeEach(() => {
			setContextMenuMode('select')
			editor.updateInstanceState({ isCoarsePointer: true })
		})

		it.each(CREATION_TOOLS)(
			'$tool cancels creation and switches to the select tool, leaving no shape behind',
			({ tool }) => {
				editor.setCurrentTool(tool)
				editor.pointerDown(100, 100)
				vi.advanceTimersByTime(editor.options.longPressDurationMs)

				// routed through the select tool so the menu has full content
				editor.expectToBeIn('select.idle')
				expect(editor.getCurrentPageShapes()).toHaveLength(0)

				editor.pointerUp(100, 100)
				expect(editor.getCurrentPageShapes()).toHaveLength(0)
			}
		)

		it('selects the shape under the pointer so the menu reflects it', () => {
			const id = createShapeId()
			editor.createShape({
				id,
				type: 'geo',
				x: 0,
				y: 0,
				props: { w: 100, h: 100, geo: 'rectangle' },
			})
			editor.selectNone()

			// long-press over the existing shape while a shape-creation tool is active
			editor.setCurrentTool('geo')
			editor.pointerDown(50, 50)
			vi.advanceTimersByTime(editor.options.longPressDurationMs)

			editor.expectToBeIn('select.idle')
			expect(editor.getSelectedShapeIds()).toEqual([id])
			// the long-press didn't create a second shape
			expect(editor.getCurrentPageShapes()).toHaveLength(1)
		})

		it('clears the selection when long-pressing empty canvas', () => {
			const id = createShapeId()
			editor.createShape({
				id,
				type: 'geo',
				x: 0,
				y: 0,
				props: { w: 100, h: 100, geo: 'rectangle' },
			})
			editor.select(id)

			// long-press far away from the shape
			editor.setCurrentTool('geo')
			editor.pointerDown(500, 500)
			vi.advanceTimersByTime(editor.options.longPressDurationMs)

			editor.expectToBeIn('select.idle')
			expect(editor.getSelectedShapeIds()).toEqual([])
		})
	})

	describe('with a coarse pointer, contextMenuMode=tool-select', () => {
		beforeEach(() => {
			setContextMenuMode('tool-select')
			editor.updateInstanceState({ isCoarsePointer: true })
		})

		it.each(CREATION_TOOLS)(
			'$tool cancels creation and stays in its own idle, leaving no shape behind',
			({ tool }) => {
				editor.setCurrentTool(tool)
				editor.pointerDown(100, 100)
				vi.advanceTimersByTime(editor.options.longPressDurationMs)

				// stays in the active tool (no tool switch), but selection may change
				editor.expectToBeIn(`${tool}.idle`)
				expect(editor.getCurrentPageShapes()).toHaveLength(0)

				editor.pointerUp(100, 100)
				expect(editor.getCurrentPageShapes()).toHaveLength(0)
			}
		)

		it('selects the shape under the pointer without switching tools', () => {
			const id = createShapeId()
			editor.createShape({
				id,
				type: 'geo',
				x: 0,
				y: 0,
				props: { w: 100, h: 100, geo: 'rectangle' },
			})
			editor.selectNone()

			editor.setCurrentTool('geo')
			editor.pointerDown(50, 50)
			vi.advanceTimersByTime(editor.options.longPressDurationMs)

			// the shape is selected so the menu reflects it, but we stay in geo
			editor.expectToBeIn('geo.idle')
			expect(editor.getSelectedShapeIds()).toEqual([id])
			expect(editor.getCurrentPageShapes()).toHaveLength(1)
		})

		it('clears the selection when long-pressing empty canvas without switching tools', () => {
			const id = createShapeId()
			editor.createShape({
				id,
				type: 'geo',
				x: 0,
				y: 0,
				props: { w: 100, h: 100, geo: 'rectangle' },
			})
			editor.select(id)

			editor.setCurrentTool('geo')
			editor.pointerDown(500, 500)
			vi.advanceTimersByTime(editor.options.longPressDurationMs)

			editor.expectToBeIn('geo.idle')
			expect(editor.getSelectedShapeIds()).toEqual([])
		})
	})

	describe('with a fine pointer, the long press is ignored in either mode', () => {
		beforeEach(() => {
			editor.updateInstanceState({ isCoarsePointer: false })
		})

		it.each(CREATION_TOOLS)(
			'$tool stays in $pointingState (contextMenuMode=tool)',
			({ tool, pointingState }) => {
				setContextMenuMode('tool')
				editor.setCurrentTool(tool)
				editor.pointerDown(100, 100)
				editor.expectToBeIn(pointingState)

				vi.advanceTimersByTime(editor.options.longPressDurationMs)

				// desktop behavior is preserved: the tool is still mid-creation
				editor.expectToBeIn(pointingState)
			}
		)

		it.each(CREATION_TOOLS)(
			'$tool stays in $pointingState (contextMenuMode=select)',
			({ tool, pointingState }) => {
				setContextMenuMode('select')
				editor.setCurrentTool(tool)
				editor.pointerDown(100, 100)
				editor.expectToBeIn(pointingState)

				vi.advanceTimersByTime(editor.options.longPressDurationMs)

				editor.expectToBeIn(pointingState)
			}
		)
	})
})
