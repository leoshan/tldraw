import { createShapeId } from '@tldraw/editor'
import { TestEditor } from './TestEditor'

let editor: TestEditor

beforeEach(() => {
	editor = new TestEditor()
})
afterEach(() => {
	editor?.dispose()
	window.history.replaceState(null, '', '/')
})

// Right-clicking with a shape-creation tool active should reveal the context
// menu following the same `contextMenuMode` logic as a touch long-press. A
// right-click is dispatched as `right_click` (not `pointer_down`), so it lands
// on the tool's idle leaf and never enters the pointing state — it never
// creates a shape, and is not coarse-pointer gated. See #8277.
//
//   - 'tool' (default): stay in the current tool; the browser opens the menu.
//   - 'tool-select': stay in the current tool but select the shape under the
//     pointer so the menu carries the full set of shape actions.
//   - 'select': switch to the select tool and select the shape under the
//     pointer so the menu carries the full set of shape actions.
const CREATION_TOOLS = [
	{ tool: 'geo' },
	{ tool: 'note' },
	{ tool: 'text' },
	{ tool: 'line' },
	{ tool: 'arrow' },
	{ tool: 'draw' },
	{ tool: 'frame' },
] as const

function setContextMenuMode(mode: 'tool' | 'tool-select' | 'select') {
	const search = mode === 'tool' ? '' : `?contextMenuMode=${mode}`
	window.history.replaceState(null, '', `/${search}`)
}

describe('right click on shape-creation tools', () => {
	describe('contextMenuMode=tool (default)', () => {
		beforeEach(() => {
			setContextMenuMode('tool')
		})

		it.each(CREATION_TOOLS)('$tool stays in its own idle and creates no shape', ({ tool }) => {
			editor.setCurrentTool(tool)
			editor.expectToBeIn(`${tool}.idle`)

			editor.rightClick(100, 100)

			// the menu opens via the browser; the tool stays active
			editor.expectToBeIn(`${tool}.idle`)
			expect(editor.getCurrentPageShapes()).toHaveLength(0)
		})
	})

	describe('contextMenuMode=select', () => {
		beforeEach(() => {
			setContextMenuMode('select')
		})

		it.each(CREATION_TOOLS)(
			'$tool switches to the select tool and creates no shape',
			({ tool }) => {
				editor.setCurrentTool(tool)

				editor.rightClick(100, 100)

				editor.expectToBeIn('select.idle')
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

			editor.setCurrentTool('geo')
			editor.rightClick(50, 50)

			editor.expectToBeIn('select.idle')
			expect(editor.getSelectedShapeIds()).toEqual([id])
		})

		it('clears the selection when right-clicking empty canvas', () => {
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
			editor.rightClick(500, 500)

			editor.expectToBeIn('select.idle')
			expect(editor.getSelectedShapeIds()).toEqual([])
		})
	})

	describe('contextMenuMode=tool-select', () => {
		beforeEach(() => {
			setContextMenuMode('tool-select')
		})

		it.each(CREATION_TOOLS)('$tool stays in its own idle and creates no shape', ({ tool }) => {
			editor.setCurrentTool(tool)

			editor.rightClick(100, 100)

			// stays in the active tool (no switch), selection may change
			editor.expectToBeIn(`${tool}.idle`)
			expect(editor.getCurrentPageShapes()).toHaveLength(0)
		})

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
			editor.rightClick(50, 50)

			editor.expectToBeIn('geo.idle')
			expect(editor.getSelectedShapeIds()).toEqual([id])
		})

		it('clears the selection when right-clicking empty canvas without switching tools', () => {
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
			editor.rightClick(500, 500)

			editor.expectToBeIn('geo.idle')
			expect(editor.getSelectedShapeIds()).toEqual([])
		})
	})
})
