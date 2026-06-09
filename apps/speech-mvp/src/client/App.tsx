import { useSync } from '@tldraw/sync'
import { useCallback, useRef, useState } from 'react'
import { Editor, TLAssetStore, TLShapeId, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { useScreenCapture } from './useScreenCapture'
import { ClickPos, useSpeech } from './useSpeech'
import { useSystemAudio } from './useSystemAudio'

const SERVER = 'http://localhost:5858'
const ROOM_ID = 'speech-room'

// Convert uploaded files to base64 data URLs so they work without a server
const noopAssets: TLAssetStore = {
	async upload(_asset, file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve({ src: reader.result as string })
			reader.onerror = reject
			reader.readAsDataURL(file)
		})
	},
	resolve(asset) {
		return (asset.props as any).src ?? null
	},
}

function exportAsTldr(editor: Editor) {
	const snapshot = editor.getStoreSnapshot()
	const json = JSON.stringify(snapshot, null, 2)
	const blob = new Blob([json], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = `${ROOM_ID}-${Date.now()}.tldr`
	a.click()
	URL.revokeObjectURL(url)
}

export default function App() {
	const store = useSync({
		uri: `ws://localhost:5858/connect/${ROOM_ID}`,
		assets: noopAssets,
	})

	const editorRef = useRef<Editor | null>(null)
	const clickPosRef = useRef<ClickPos | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const [clickPosDisplay, setClickPosDisplay] = useState<ClickPos | null>(null)

	const { state: speechState, start, stop } = useSpeech(ROOM_ID, clickPosRef)
	const {
		state: sysAudioState,
		start: startSysAudio,
		stop: stopSysAudio,
	} = useSystemAudio(ROOM_ID, clickPosRef)
	const {
		state: captureState,
		captureScreen,
		uploadImage,
	} = useScreenCapture(
		ROOM_ID,
		clickPosRef,
		useCallback(() => {
			const editor = editorRef.current
			if (!editor) return null
			const vp = editor.getViewportPageBounds()
			return { x: vp.x, y: vp.y, w: vp.w, h: vp.h }
		}, [])
	)

	const [prompt, setPrompt] = useState('')
	const [agentStatus, setAgentStatus] = useState<'idle' | 'streaming'>('idle')
	const [lang, setLang] = useState('zh-CN')
	const [selectedCount, setSelectedCount] = useState(0)
	const [annotateStatus, setAnnotateStatus] = useState<'idle' | 'loading'>('idle')

	async function annotateSelection() {
		const editor = editorRef.current
		if (!editor) return
		const ids = editor.getSelectedShapeIds() as TLShapeId[]
		if (ids.length === 0) return
		setAnnotateStatus('loading')
		try {
			await fetch(`${SERVER}/annotate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ roomId: ROOM_ID, shapeIds: ids }),
			})
		} finally {
			setAnnotateStatus('idle')
		}
	}

	async function sendToAgent() {
		const trimmed = prompt.trim()
		if (!trimmed) return
		setAgentStatus('streaming')
		setPrompt('')
		try {
			const resp = await fetch(`${SERVER}/agent`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: trimmed,
					roomId: ROOM_ID,
					...(clickPosRef.current && { x: clickPosRef.current.x, y: clickPosRef.current.y }),
				}),
			})
			// Consume the SSE stream (canvas updates happen server-side, we just drain)
			if (resp.body) {
				const reader = resp.body.getReader()
				while (true) {
					const { done } = await reader.read()
					if (done) break
				}
			}
		} finally {
			setAgentStatus('idle')
		}
	}

	const speechLabel = {
		idle: '🎤 开始语音',
		listening: '⏹ 停止语音',
		error: '⚠ 重试语音',
		unsupported: '🚫 不支持',
	}[speechState]

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
			{/* Control bar */}
			<div
				style={{
					display: 'flex',
					gap: 8,
					padding: '8px 12px',
					background: '#f5f5f5',
					borderBottom: '1px solid #e0e0e0',
					alignItems: 'center',
					flexShrink: 0,
					flexWrap: 'wrap',
				}}
			>
				<select
					value={lang}
					onChange={(e) => setLang(e.target.value)}
					style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
					disabled={speechState === 'listening'}
				>
					<option value="zh-CN">中文</option>
					<option value="en-US">English</option>
				</select>

				<button
					onClick={speechState === 'listening' ? stop : () => start(lang)}
					disabled={speechState === 'unsupported'}
					style={{
						background:
							speechState === 'listening'
								? '#ef4444'
								: speechState === 'unsupported'
									? '#9ca3af'
									: '#22c55e',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: speechState === 'unsupported' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					{speechLabel}
				</button>

				<button
					onClick={sysAudioState === 'capturing' ? stopSysAudio : startSysAudio}
					disabled={sysAudioState === 'unsupported'}
					title={
						sysAudioState === 'unsupported'
							? '浏览器不支持系统音频采集'
							: sysAudioState === 'capturing'
								? '停止采集（停止后自动标注）'
								: '采集系统音频输出 → Whisper 转写 → 白板'
					}
					style={{
						background:
							sysAudioState === 'capturing'
								? '#ef4444'
								: sysAudioState === 'unsupported'
									? '#9ca3af'
									: '#8b5cf6',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: sysAudioState === 'unsupported' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					{sysAudioState === 'capturing'
						? '⏹ 停止音频'
						: sysAudioState === 'unsupported'
							? '🚫 不支持'
							: sysAudioState === 'error'
								? '⚠ 重试音频'
								: '🔊 系统音频'}
				</button>

				{/* ── Screenshot button ── */}
				<button
					onClick={captureScreen}
					disabled={captureState !== 'idle' && captureState !== 'error'}
					title={
						captureState === 'picking'
							? '浏览器弹窗已打开，请选择要截图的窗口，然后点击"开始共享"'
							: captureState === 'capturing'
								? '已选择窗口，正在捕获画面…'
								: captureState === 'uploading'
									? '截图已发送，AI 分析中…'
									: captureState === 'error'
										? '截图失败，点击重试'
										: '点击后选择要截图的窗口 → 点"开始共享" → 自动截图并 AI 分析 → 白板'
					}
					style={{
						background:
							captureState === 'error'
								? '#ef4444'
								: captureState !== 'idle'
									? '#6b7280'
									: '#0ea5e9',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: captureState === 'idle' || captureState === 'error' ? 'pointer' : 'not-allowed',
						fontWeight: 600,
						fontSize: 13,
						opacity: captureState === 'picking' || captureState === 'capturing' ? 0.7 : 1,
					}}
				>
					{captureState === 'picking'
						? '📸 选择窗口…'
						: captureState === 'capturing'
							? '📸 捕获中…'
							: captureState === 'uploading'
								? '🔍 分析中…'
								: captureState === 'error'
									? '⚠ 重试截图'
									: '📸 截图'}
				</button>

				{/* ── Image upload button + hidden file input ── */}
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					style={{ display: 'none' }}
					onChange={(e) => {
						const file = e.target.files?.[0]
						if (file) uploadImage(file)
						e.target.value = ''
					}}
				/>
				<button
					onClick={() => fileInputRef.current?.click()}
					disabled={captureState !== 'idle'}
					title="上传本地图片 → 视觉分析 → 白板"
					style={{
						background: captureState !== 'idle' ? '#6b7280' : '#0d9488',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: captureState !== 'idle' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
						opacity: captureState !== 'idle' ? 0.6 : 1,
					}}
				>
					🖼 上传
				</button>

				<div style={{ width: 1, height: 24, background: '#ddd', margin: '0 4px' }} />

				<input
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendToAgent()}
					placeholder="向 Agent 提问… (回车发送)"
					style={{
						flex: 1,
						minWidth: 200,
						padding: '6px 10px',
						borderRadius: 6,
						border: '1px solid #ccc',
						fontSize: 13,
					}}
					disabled={agentStatus === 'streaming'}
				/>

				<button
					onClick={sendToAgent}
					disabled={agentStatus === 'streaming' || !prompt.trim()}
					style={{
						background: '#6366f1',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
						opacity: agentStatus === 'streaming' || !prompt.trim() ? 0.5 : 1,
					}}
				>
					{agentStatus === 'streaming' ? '生成中…' : '发送给 Agent'}
				</button>

				<button
					onClick={() => editorRef.current && exportAsTldr(editorRef.current)}
					disabled={!editorRef.current}
					style={{
						background: '#0ea5e9',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					⬇ 导出 .tldr
				</button>

				<button
					onClick={async () => {
						const resp = await fetch(`${SERVER}/transcript/${ROOM_ID}`)
						if (!resp.ok) {
							alert('暂无转写记录')
							return
						}
						const blob = await resp.blob()
						const url = URL.createObjectURL(blob)
						const a = document.createElement('a')
						a.href = url
						a.download = `transcript-${ROOM_ID}-${Date.now()}.jsonl`
						a.click()
						URL.revokeObjectURL(url)
					}}
					title="下载完整转写记录（JSONL 格式）"
					style={{
						background: '#0ea5e9',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					⬇ 转写记录
				</button>

				<button
					onClick={annotateSelection}
					disabled={selectedCount === 0 || annotateStatus === 'loading'}
					title={selectedCount === 0 ? '先在白板上框选形状' : `标注选中的 ${selectedCount} 个形状`}
					style={{
						background: selectedCount === 0 ? '#d97706' : '#f59e0b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
						opacity: selectedCount === 0 || annotateStatus === 'loading' ? 0.5 : 1,
					}}
				>
					{annotateStatus === 'loading'
						? '标注中…'
						: `🗂 标注摘要${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
				</button>

				<span
					style={{
						fontSize: 12,
						color: '#888',
						marginLeft: 'auto',
						whiteSpace: 'nowrap',
					}}
				>
					{clickPosDisplay ? `📍 (${clickPosDisplay.x}, ${clickPosDisplay.y})` : '📍 点击画布定位'}
					{agentStatus === 'streaming' && ' · Agent 输出中…'}
				</span>
			</div>

			{/* tldraw canvas — pointer down sets speech/agent origin position */}
			<div
				style={{ flex: 1, position: 'relative' }}
				onPointerDown={(e) => {
					if (!editorRef.current) return
					const pos = editorRef.current.screenToPage({ x: e.clientX, y: e.clientY })
					const rounded = { x: Math.round(pos.x), y: Math.round(pos.y) }
					clickPosRef.current = rounded
					setClickPosDisplay(rounded)
				}}
			>
				<Tldraw
					store={store}
					onMount={useCallback(
						(editor: Editor) => {
							editorRef.current = editor
							// Track selection count so the annotate button enables/disables correctly
							editor.store.listen(() => {
								setSelectedCount(editor.getSelectedShapeIds().length)
							})
						},
						// eslint-disable-next-line react-hooks/exhaustive-deps
						[]
					)}
				/>
			</div>
		</div>
	)
}
