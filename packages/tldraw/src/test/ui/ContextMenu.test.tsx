import { act, fireEvent, screen } from '@testing-library/react'
import { createShapeId } from '@tldraw/editor'
import { TLComponents, Tldraw } from '../../lib/Tldraw'
import { DefaultContextMenu } from '../../lib/ui/components/ContextMenu/DefaultContextMenu'
import {
	renderTldrawComponent,
	renderTldrawComponentWithEditor,
} from '../testutils/renderTldrawComponent'

afterEach(() => {
	window.history.replaceState(null, '', '/')
})

it('opens on right-click', async () => {
	await renderTldrawComponent(
		<Tldraw
			onMount={(editor) => {
				editor.createShape({ id: createShapeId(), type: 'geo' })
			}}
		/>,
		{ waitForPatterns: false }
	)
	const canvas = await screen.findByTestId('canvas')

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	await screen.findByTestId('context-menu.select-all')

	fireEvent.keyDown(document.body, { key: 'Escape' })
	expect(screen.queryByTestId('context-menu')).toBeNull()
})

it('has content when a non-select tool is active', async () => {
	// Regression for #8828: the menu used to bail out (render nothing) unless
	// the select tool was active, so right-clicking with a shape-creation tool
	// active opened an empty menu. Each submenu self-hides when inapplicable, so
	// the outer guard was removed.
	await renderTldrawComponent(
		<Tldraw
			onMount={(editor) => {
				editor.createShape({ id: createShapeId(), type: 'geo' })
				editor.setCurrentTool('geo')
			}}
		/>,
		{ waitForPatterns: false }
	)
	const canvas = await screen.findByTestId('canvas')

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	// the menu still offers canvas-level actions even though we're not in select
	await screen.findByTestId('context-menu.select-all')
})

it('right-click in a shape tool reveals shape actions (contextMenuMode=select, rightClickPanning off)', async () => {
	// Regression for the select-mode fix to #8277: a right-click while a
	// shape-creation tool is active should switch to the select tool and select
	// the shape under the pointer *before* the menu opens, so the menu carries
	// the full set of shape actions. With rightClickPanning off the native
	// contextmenu fires on press, so the switch must complete synchronously on
	// the pointer-down — this asserts the switch beats the menu.
	window.history.replaceState(null, '', '/?contextMenuMode=select')

	const id = createShapeId()
	const { editor } = await renderTldrawComponentWithEditor(
		(onMount) => (
			<Tldraw
				options={{ rightClickPanning: false }}
				onMount={(editor) => {
					editor.createShape({
						id,
						type: 'geo',
						x: 0,
						y: 0,
						props: { w: 100, h: 100, geo: 'rectangle' },
					})
					editor.setCurrentTool('geo')
					onMount(editor)
				}}
			/>
		),
		{ waitForPatterns: false }
	)

	const canvas = await screen.findByTestId('canvas')

	// right-click over the shape: the button-2 pointer-down dispatches a
	// `right_click`, which the geo tool's idle routes through the select tool.
	act(() => {
		editor.dispatch({
			type: 'pointer',
			name: 'pointer_down',
			target: 'canvas',
			point: { x: 50, y: 50, z: 0.5 },
			pointerId: 1,
			button: 2,
			isPen: false,
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			accelKey: false,
		})
	})

	// the switch beats the menu: select is active and the shape is selected
	// before the contextmenu event is ever handled
	expect(editor.getCurrentToolId()).toBe('select')
	expect(editor.getSelectedShapeIds()).toEqual([id])

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	// shape actions are present because the shape is selected
	await screen.findByTestId('context-menu.cut')
	await screen.findByTestId('context-menu.copy')
	await screen.findByTestId('context-menu.delete')
})

it('contextMenuMode=tool-select reveals the full menu without switching tools', async () => {
	// tool-select selects the shape under the pointer but stays in the creation
	// tool. The selection actions (cut/copy/delete) are normally gated on
	// `editor.isIn('select')`; tool-select relaxes that gate so the menu is
	// complete even though we're still in the geo tool.
	window.history.replaceState(null, '', '/?contextMenuMode=tool-select')

	const id = createShapeId()
	const { editor } = await renderTldrawComponentWithEditor(
		(onMount) => (
			<Tldraw
				options={{ rightClickPanning: false }}
				onMount={(editor) => {
					editor.createShape({
						id,
						type: 'geo',
						x: 0,
						y: 0,
						props: { w: 100, h: 100, geo: 'rectangle' },
					})
					editor.setCurrentTool('geo')
					onMount(editor)
				}}
			/>
		),
		{ waitForPatterns: false }
	)

	const canvas = await screen.findByTestId('canvas')

	act(() => {
		editor.dispatch({
			type: 'pointer',
			name: 'pointer_down',
			target: 'canvas',
			point: { x: 50, y: 50, z: 0.5 },
			pointerId: 1,
			button: 2,
			isPen: false,
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			accelKey: false,
		})
	})

	// stays in the creation tool, but the shape is selected
	expect(editor.getCurrentToolId()).toBe('geo')
	expect(editor.getSelectedShapeIds()).toEqual([id])

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	// full shape actions are present despite not being in the select tool
	await screen.findByTestId('context-menu.cut')
	await screen.findByTestId('context-menu.copy')
	await screen.findByTestId('context-menu.delete')
})

it('contextMenuMode=tool keeps cut/copy/delete hidden even with a selection', async () => {
	// Guards that the tool-select relaxation did NOT change plain `tool` mode:
	// with a creation tool active, selection actions stay hidden even when a
	// shape happens to be selected (e.g. a leftover selection).
	const id = createShapeId()
	await renderTldrawComponent(
		<Tldraw
			onMount={(editor) => {
				editor.createShape({
					id,
					type: 'geo',
					x: 0,
					y: 0,
					props: { w: 100, h: 100, geo: 'rectangle' },
				})
				editor.setSelectedShapes([id])
				editor.setCurrentTool('geo')
			}}
		/>,
		{ waitForPatterns: false }
	)

	const canvas = await screen.findByTestId('canvas')

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	// canvas-level actions remain, but selection-targeting actions stay hidden
	await screen.findByTestId('context-menu.select-all')
	expect(screen.queryByTestId('context-menu.cut')).toBeNull()
	expect(screen.queryByTestId('context-menu.copy')).toBeNull()
	expect(screen.queryByTestId('context-menu.delete')).toBeNull()
})

it('tunnels context menu', async () => {
	const components: TLComponents = {
		ContextMenu: (props) => {
			return (
				<DefaultContextMenu {...props}>
					<button data-testid="abc123">Hello</button>
				</DefaultContextMenu>
			)
		},
	}
	await renderTldrawComponent(
		<Tldraw
			onMount={(editor) => {
				editor.createShape({ id: createShapeId(), type: 'geo' })
			}}
			components={components}
		/>,
		{ waitForPatterns: false }
	)

	const canvas = await screen.findByTestId('canvas')

	fireEvent.contextMenu(canvas)
	await screen.findByTestId('context-menu')
	const elm = await screen.findByTestId('abc123')
	expect(elm).toBeDefined()
})
