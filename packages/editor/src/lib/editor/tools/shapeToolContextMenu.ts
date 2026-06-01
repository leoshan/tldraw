import type { Editor } from '../Editor'

/**
 * Which behaviour a context-menu gesture (touch long-press or right-click)
 * should trigger when a shape-creation tool is active. This is an exploration
 * flag, selected at runtime via the `contextMenuMode` query param, so the
 * designs for fixing the touch/right-click context menu (issue #8277) can be
 * compared side by side. The two axes are: does it select the shape under the
 * pointer, and does it switch to the select tool?
 *
 * - `'tool'` (default): cancel any pending creation and stay in the current
 *   tool, without touching the selection. The browser-fired `contextmenu` opens
 *   the menu with canvas-level actions only. This is the per-tool, "not via the
 *   selection tool" design.
 * - `'tool-select'`: like `'tool'`, but also select the shape under the pointer
 *   so the menu carries the full set of shape actions. Stays in the current
 *   tool — note that creation tools render no selection chrome, so the
 *   selection is not visually indicated.
 * - `'select'`: cancel, switch to the select tool, and select the shape under
 *   the pointer — the menu carries the full set of shape actions and the
 *   selection is shown with its normal bounds.
 *
 * @internal
 */
export type TLContextMenuMode = 'tool' | 'tool-select' | 'select'

/**
 * Read the context-menu exploration mode from the `contextMenuMode` query
 * param. Defaults to `'tool'` (and on the server, where there is no `window`).
 *
 * @internal
 */
export function getContextMenuMode(): TLContextMenuMode {
	if (typeof window === 'undefined') return 'tool'
	const value = new URLSearchParams(window.location.search).get('contextMenuMode')
	if (value === 'select') return 'select'
	if (value === 'tool-select') return 'tool-select'
	return 'tool'
}

/**
 * Shared handler for a long-press in a shape-creation tool's pointing/drawing
 * state. On a coarse pointer this cancels any pending shape creation so the
 * browser-fired `contextmenu` opens cleanly, with no stray shape left behind
 * (issue #8277).
 *
 * Gated on `isCoarsePointer`: on a fine pointer (mouse) the long-press timer
 * powers the deliberate "pause before drag to start a precise arrow" gesture,
 * which we must not disturb. The bug only manifests on coarse pointers, because
 * that is also where the browser fires `contextmenu` at the long-press mark.
 *
 * The `cancelPendingCreation` callback is the tool's own cleanup — it knows
 * whether it needs to `bailToMark` a shape it created early (note, draw, arrow,
 * line, text) or simply transition back to idle (geo, box).
 *
 * @internal
 */
export function handleShapeCreationLongPress(
	editor: Editor,
	cancelPendingCreation: () => void
): void {
	if (!editor.getInstanceState().isCoarsePointer) return

	cancelPendingCreation()

	applyContextMenuMode(editor)
}

/**
 * Shared handler for a right-click in a shape-creation tool's idle state. A
 * right-click is dispatched as `right_click` (not `pointer_down`), so it never
 * enters the pointing state and never creates a shape — there is nothing to
 * cancel. The selection/tool side effects mirror the long-press behaviour.
 *
 * @internal
 */
export function handleShapeCreationRightClick(editor: Editor): void {
	applyContextMenuMode(editor)
}

/**
 * Apply the configured `contextMenuMode` side effects: optionally switch to the
 * select tool, and optionally select the shape under the pointer.
 */
function applyContextMenuMode(editor: Editor): void {
	const mode = getContextMenuMode()
	if (mode === 'tool') return

	if (mode === 'select') {
		editor.setCurrentTool('select')
	}

	selectShapeUnderPointer(editor)
}

/**
 * Mirror SelectTool Idle.onRightClick (canvas case): select the outermost
 * selectable shape under the pointer so the menu reflects it, otherwise clear
 * the selection.
 */
function selectShapeUnderPointer(editor: Editor): void {
	const point = editor.inputs.getCurrentPagePoint()
	const hit = editor.getShapeAtPoint(point, {
		margin: editor.options.hitTestMargin / editor.getZoomLevel(),
		hitInside: false,
		hitLabels: true,
		hitLocked: true,
		hitFrameInside: true,
		renderingOnly: true,
	})

	if (hit) {
		const target = editor.getOutermostSelectableShape(hit)
		editor.markHistoryStoppingPoint('selecting shape')
		editor.setSelectedShapes([target.id])
	} else {
		editor.selectNone()
	}
}
