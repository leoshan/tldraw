import { useSync } from '@tldraw/sync'
import { useRef, useState } from 'react'
import { Editor, TLAssetStore, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { ClickPos, useSpeech } from './useSpeech'

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
	const [clickPosDisplay, setClickPosDisplay] = useState<ClickPos | null>(null)

	const { state: speechState, start, stop } = useSpeech(ROOM_ID, clickPosRef)

	const [prompt, setPrompt] = useState('')
	const [agentStatus, setAgentStatus] = useState<'idle' | 'streaming'>('idle')
	const [lang, setLang] = useState('zh-CN')

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
					onMount={(editor) => {
						editorRef.current = editor
					}}
				/>
			</div>
		</div>
	)
}
