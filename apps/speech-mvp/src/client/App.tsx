import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, TLAssetStore, TLShapeId, Tldraw, serializeTldrawJson } from 'tldraw'
import 'tldraw/tldraw.css'
import { useScreenCapture } from './useScreenCapture'
import { ClickPos, SpeechMode, useSpeech } from './useSpeech'
import { useSystemAudio } from './useSystemAudio'

const SERVER = 'http://localhost:5858'
const ROOM_ID = new URLSearchParams(window.location.search).get('room') || 'speech-room'

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

async function exportAsTldr(editor: Editor) {
	try {
		const json = await serializeTldrawJson(editor)
		const blob = new Blob([json], { type: 'application/vnd.tldraw+json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `${ROOM_ID}-${Date.now()}.tldr`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	} catch (e) {
		console.error('Export failed:', e)
		alert('导出失败：' + String(e))
	}
}

export default function App() {
	const store = useSync({
		uri: `ws://localhost:5858/connect/${ROOM_ID}`,
		assets: noopAssets,
	})

	const editorRef = useRef<Editor | null>(null)
	const clickPosRef = useRef<ClickPos | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const tldrInputRef = useRef<HTMLInputElement | null>(null)
	const [clickPosDisplay, setClickPosDisplay] = useState<ClickPos | null>(null)

	const { state: speechState, start, stop } = useSpeech(ROOM_ID, clickPosRef)
	const {
		state: sysAudioState,
		chunkCount,
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
	const [speechMode, setSpeechMode] = useState<SpeechMode>('stt')
	const [selectedCount, setSelectedCount] = useState(0)
	const [annotateStatus, setAnnotateStatus] = useState<'idle' | 'loading'>('idle')
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
	const [showHistory, setShowHistory] = useState(false)
	interface CheckpointMeta {
		id: number
		name: string
		createdAt: number
	}
	const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
	const [restoringId, setRestoringId] = useState<number | null>(null)
	const [showRoomPicker, setShowRoomPicker] = useState(false)
	interface RoomMeta {
		roomId: string
		lastActive: number
	}
	const [roomList, setRoomList] = useState<RoomMeta[]>([])

	useEffect(() => {
		if (!showRoomPicker) return
		const close = (e: MouseEvent) => {
			if (!(e.target as Element).closest('[data-room-picker]')) setShowRoomPicker(false)
		}
		document.addEventListener('mousedown', close)
		return () => document.removeEventListener('mousedown', close)
	}, [showRoomPicker])

	useEffect(() => {
		if (!showHistory) return
		fetch(`${SERVER}/rooms/${ROOM_ID}/checkpoints`)
			.then((r) => r.json())
			.then((data) => setCheckpoints(data.checkpoints ?? []))
			.catch(() => setCheckpoints([]))
	}, [showHistory])

	async function restoreCheckpoint(id: number) {
		const editor = editorRef.current
		if (!editor) return
		setRestoringId(id)
		try {
			const resp = await fetch(`${SERVER}/rooms/${ROOM_ID}/checkpoints/${id}`)
			if (!resp.ok) {
				alert('快照加载失败')
				return
			}
			const snapshot = await resp.json()
			editor.loadSnapshot(snapshot)
		} finally {
			setRestoringId(null)
			setShowHistory(false)
		}
	}

	async function saveCanvasCheckpoint() {
		setSaveStatus('saving')
		try {
			const resp = await fetch(`${SERVER}/rooms/${ROOM_ID}/checkpoint`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: `snapshot-${new Date().toLocaleString('zh-CN')}` }),
			})
			if (resp.ok) {
				setSaveStatus('saved')
				setTimeout(() => setSaveStatus('idle'), 2000)
			} else {
				setSaveStatus('idle')
				alert('快照保存失败：房间未就绪，请稍后重试')
			}
		} catch {
			setSaveStatus('idle')
		}
	}

	async function annotateSelection() {
		const editor = editorRef.current
		if (!editor) return
		const ids = editor.getSelectedShapeIds() as TLShapeId[]
		if (ids.length === 0) return
		setAnnotateStatus('loading')
		try {
			const resp = await fetch(`${SERVER}/annotate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ roomId: ROOM_ID, shapeIds: ids }),
			})
			if (resp.body) {
				const reader = resp.body.getReader()
				while (true) {
					const { done } = await reader.read()
					if (done) break
				}
			}
		} catch (err) {
			console.error('Annotation stream failed:', err)
		} finally {
			setAnnotateStatus('idle')
		}
	}

	const [minutesStatus, setMinutesStatus] = useState<'idle' | 'loading'>('idle')

	async function exportRoomSummaries() {
		const editor = editorRef.current
		if (!editor) return
		const currentPageId = editor.getCurrentPageId() as string
		try {
			const resp = await fetch(`${SERVER}/rooms/${ROOM_ID}/summaries?pageId=${currentPageId}`)
			if (!resp.ok) {
				alert('获取摘要失败')
				return
			}
			const { markdown } = await resp.json()
			if (!markdown) {
				alert('当前页面没有找到橙色的摘要卡片')
				return
			}
			const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = `summaries-${ROOM_ID}-${currentPageId}-${Date.now()}.md`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
		} catch (err) {
			console.error('Export summaries failed:', err)
			alert('导出失败：' + String(err))
		}
	}

	async function generateMeetingMinutes() {
		const editor = editorRef.current
		if (!editor) return
		const currentPageId = editor.getCurrentPageId() as string
		setMinutesStatus('loading')
		try {
			const resp = await fetch(`${SERVER}/rooms/${ROOM_ID}/minutes`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pageId: currentPageId }),
			})
			if (!resp.ok) {
				const data = await resp.json()
				alert(data.error || '生成会议纪要失败')
				return
			}
			// Consume the SSE stream to track completion
			if (resp.body) {
				const reader = resp.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					const lines = buffer.split('\n')
					buffer = lines.pop() || ''
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							try {
								const data = JSON.parse(line.slice(6))
								if (data.error) {
									alert('大模型错误: ' + data.error)
								}
							} catch (_e) {
								// ignore malformed SSE lines
							}
						}
					}
				}
			}
		} catch (err) {
			console.error('Generate minutes failed:', err)
			alert('生成失败：' + String(err))
		} finally {
			setMinutesStatus('idle')
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
				{/* ── 语音输入 ── */}
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
					onClick={
						speechState === 'listening'
							? stop
							: () =>
									start(
										lang,
										speechMode,
										editorRef.current?.getCurrentPageId() as string | undefined
									)
					}
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
					onClick={() => setSpeechMode((m) => (m === 'stt' ? 'webspeech' : 'stt'))}
					disabled={speechState === 'listening'}
					title={
						speechMode === 'stt'
							? '当前：STT provider（点击切换到浏览器 Web Speech）'
							: '当前：浏览器 Web Speech（点击切换到 STT provider）'
					}
					style={{
						background: speechMode === 'stt' ? '#6366f1' : '#0891b2',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 10px',
						cursor: speechState === 'listening' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 12,
						opacity: speechState === 'listening' ? 0.5 : 1,
					}}
				>
					{speechMode === 'stt' ? 'STT' : 'Web'}
				</button>

				<button
					onClick={
						sysAudioState === 'capturing' || sysAudioState === 'no_audio'
							? stopSysAudio
							: () => startSysAudio(editorRef.current?.getCurrentPageId() as string | undefined)
					}
					disabled={sysAudioState === 'unsupported'}
					title={
						sysAudioState === 'unsupported'
							? '浏览器不支持系统音频采集'
							: sysAudioState === 'capturing'
								? `采集中（已转写 ${chunkCount} 段）… 点击停止`
								: sysAudioState === 'no_audio'
									? 'macOS：请选择「Chrome 标签页」并勾选「分享音频」。点击停止后重试'
									: '采集系统音频 → Whisper 转写 → 白板'
					}
					style={{
						background:
							sysAudioState === 'capturing'
								? '#ef4444'
								: sysAudioState === 'no_audio'
									? '#f59e0b'
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
						? `⏹ 停止音频${chunkCount > 0 ? ` (${chunkCount})` : ''}`
						: sysAudioState === 'no_audio'
							? '⚠ 未采集到音频'
							: sysAudioState === 'unsupported'
								? '🚫 不支持'
								: sysAudioState === 'error'
									? '⚠ 重试音频'
									: '🔊 系统音频'}
				</button>

				<div style={{ width: 1, height: 24, background: '#ddd', margin: '0 2px' }} />

				{/* ── 视觉 ── */}
				<button
					onClick={captureScreen}
					disabled={captureState !== 'idle' && captureState !== 'error'}
					title={
						captureState === 'picking'
							? '浏览器弹窗已打开，请选择窗口后点"开始共享"'
							: captureState === 'capturing'
								? '捕获中…'
								: captureState === 'uploading'
									? 'AI 分析中…'
									: captureState === 'error'
										? '截图失败，点击重试'
										: '截图后 AI 分析 → 白板'
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

				<div style={{ width: 1, height: 24, background: '#ddd', margin: '0 2px' }} />

				{/* ── Agent ── */}
				<input
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendToAgent()}
					placeholder="向 Agent 提问… (回车发送)"
					style={{
						flex: 1,
						minWidth: 160,
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
					{agentStatus === 'streaming' ? '生成中…' : '发送'}
				</button>
				<button
					onClick={annotateSelection}
					disabled={selectedCount === 0 || annotateStatus === 'loading'}
					title={
						selectedCount === 0 ? '先在白板上框选形状' : `AI 标注选中的 ${selectedCount} 个形状`
					}
					style={{
						background: selectedCount === 0 ? '#94a3b8' : '#f59e0b',
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
						: `🗂 标注${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
				</button>

				<button
					onClick={exportRoomSummaries}
					title="导出当前页面中所有的橙色摘要便签为 Markdown 文件"
					style={{
						background: '#d97706',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					📥 导出摘要
				</button>
				<button
					onClick={generateMeetingMinutes}
					disabled={minutesStatus === 'loading'}
					title="导出橘色摘要并提炼生成完整会议纪要卡片"
					style={{
						background: '#2563eb',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 14px',
						cursor: minutesStatus === 'loading' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
						opacity: minutesStatus === 'loading' ? 0.5 : 1,
					}}
				>
					{minutesStatus === 'loading' ? '生成纪要中…' : '📝 会议纪要'}
				</button>

				<div style={{ width: 1, height: 24, background: '#ddd', margin: '0 2px' }} />

				{/* ── 文件 ── */}
				<button
					onClick={() => editorRef.current && void exportAsTldr(editorRef.current)}
					disabled={!editorRef.current}
					title="导出为 .tldr 文件"
					style={{
						background: '#64748b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 12px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					⬇ 导出
				</button>

				<input
					ref={tldrInputRef}
					type="file"
					accept=".tldr"
					style={{ display: 'none' }}
					onChange={(e) => {
						const file = e.target.files?.[0]
						if (!file || !editorRef.current) return
						const reader = new FileReader()
						reader.onload = () => {
							try {
								const data = JSON.parse(reader.result as string)
								let snapshot: any
								if (Array.isArray(data.records)) {
									snapshot = {
										store: Object.fromEntries(data.records.map((r: any) => [r.id, r])),
										schema: data.schema,
									}
								} else if (data.document?.store) {
									snapshot = data.document
								} else if (data.store) {
									snapshot = data
								} else {
									throw new Error('无法识别的文件格式')
								}
								editorRef.current!.loadSnapshot(snapshot)
							} catch (err) {
								alert('文件解析失败：' + String(err))
							}
						}
						reader.readAsText(file)
						e.target.value = ''
					}}
				/>
				<button
					onClick={() => tldrInputRef.current?.click()}
					disabled={!editorRef.current}
					title="导入 .tldr 文件到当前画布"
					style={{
						background: '#64748b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 12px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					📂 导入
				</button>

				<button
					onClick={saveCanvasCheckpoint}
					disabled={saveStatus !== 'idle'}
					title="保存当前画布快照到服务器"
					style={{
						background: saveStatus === 'saved' ? '#16a34a' : '#64748b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 12px',
						cursor: saveStatus !== 'idle' ? 'not-allowed' : 'pointer',
						fontWeight: 600,
						fontSize: 13,
						opacity: saveStatus === 'saving' ? 0.6 : 1,
						transition: 'background 0.3s',
					}}
				>
					{saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '✓ 已保存' : '💾 快照'}
				</button>

				<button
					onClick={() => setShowHistory((v) => !v)}
					title="查看并恢复历史快照"
					style={{
						background: showHistory ? '#6366f1' : '#64748b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 12px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					📋 历史
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
					title="下载转写记录（JSONL）"
					style={{
						background: '#64748b',
						color: 'white',
						border: 'none',
						borderRadius: 6,
						padding: '6px 12px',
						cursor: 'pointer',
						fontWeight: 600,
						fontSize: 13,
					}}
				>
					⬇ 转写
				</button>

				{/* ── Room / 状态 ── */}
				<span style={{ fontSize: 12, color: '#888', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
					{clickPosDisplay ? `📍 (${clickPosDisplay.x}, ${clickPosDisplay.y})` : '📍 点击定位'}
					{agentStatus === 'streaming' && ' · 生成中…'}
				</span>

				<div style={{ width: 1, height: 24, background: '#ddd', margin: '0 2px' }} />

				{/* ── Room 选择器 ── */}
				<div style={{ position: 'relative' }} data-room-picker="1">
					<button
						onClick={() => {
							if (!showRoomPicker) {
								fetch(`${SERVER}/rooms`)
									.then((r) => r.json())
									.then((d) => setRoomList(d.rooms ?? []))
									.catch(() => setRoomList([]))
							}
							setShowRoomPicker((v) => !v)
						}}
						title="切换或查找已有 Room"
						style={{
							background: showRoomPicker ? '#6366f1' : '#e8f0fe',
							color: showRoomPicker ? 'white' : '#334155',
							border: '1px solid #c7d2fe',
							borderRadius: 6,
							padding: '5px 10px',
							cursor: 'pointer',
							fontWeight: 600,
							fontSize: 12,
							fontFamily: 'monospace',
							whiteSpace: 'nowrap',
						}}
					>
						🏠 {ROOM_ID} ▾
					</button>

					{showRoomPicker && (
						<div
							style={{
								position: 'absolute',
								top: 'calc(100% + 6px)',
								right: 0,
								width: 260,
								background: '#fff',
								border: '1px solid #e2e8f0',
								borderRadius: 8,
								boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
								zIndex: 2000,
								overflow: 'hidden',
							}}
						>
							<div
								style={{
									padding: '8px 12px',
									borderBottom: '1px solid #f1f5f9',
									fontSize: 11,
									color: '#94a3b8',
									fontWeight: 600,
									letterSpacing: '0.05em',
								}}
							>
								所有 ROOM（点击跳转）
							</div>
							<div style={{ maxHeight: 240, overflowY: 'auto' }}>
								{roomList.length === 0 ? (
									<div
										style={{ padding: '12px', fontSize: 12, color: '#94a3b8', textAlign: 'center' }}
									>
										暂无记录
									</div>
								) : (
									roomList.map((r) => (
										<div
											key={r.roomId}
											onClick={() => {
												window.location.href = `?room=${r.roomId}`
											}}
											style={{
												padding: '8px 12px',
												cursor: 'pointer',
												display: 'flex',
												justifyContent: 'space-between',
												alignItems: 'center',
												background: r.roomId === ROOM_ID ? '#eef2ff' : 'transparent',
												borderLeft:
													r.roomId === ROOM_ID ? '3px solid #6366f1' : '3px solid transparent',
											}}
											onMouseEnter={(e) => {
												if (r.roomId !== ROOM_ID)
													(e.currentTarget as HTMLDivElement).style.background = '#f8fafc'
											}}
											onMouseLeave={(e) => {
												if (r.roomId !== ROOM_ID)
													(e.currentTarget as HTMLDivElement).style.background = 'transparent'
											}}
										>
											<span
												style={{
													fontFamily: 'monospace',
													fontSize: 13,
													fontWeight: r.roomId === ROOM_ID ? 700 : 400,
												}}
											>
												{r.roomId === ROOM_ID ? '● ' : '○ '}
												{r.roomId}
											</span>
											<span style={{ fontSize: 11, color: '#94a3b8' }}>
												{new Date(r.lastActive).toLocaleDateString('zh-CN')}
											</span>
										</div>
									))
								)}
							</div>
							<div style={{ padding: '8px 12px', borderTop: '1px solid #f1f5f9' }}>
								<button
									onClick={() => {
										const id = Math.random().toString(36).slice(2, 8)
										window.location.href = `?room=${id}`
									}}
									style={{
										width: '100%',
										background: '#6366f1',
										color: 'white',
										border: 'none',
										borderRadius: 6,
										padding: '6px',
										cursor: 'pointer',
										fontWeight: 600,
										fontSize: 12,
									}}
								>
									＋ 新建 Room
								</button>
							</div>
						</div>
					)}
				</div>
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
							editor.store.listen(() => {
								setSelectedCount(editor.getSelectedShapeIds().length)
							})
							// Notify server of the active page so shapes land on the right page
							const notifyPage = (pageId: string) => {
								fetch(`${SERVER}/rooms/${ROOM_ID}/active-page`, {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ pageId }),
								}).catch(() => {})
							}
							let lastPageId = editor.getCurrentPageId() as string
							notifyPage(lastPageId)
							editor.store.listen(
								() => {
									const pageId = editor.getCurrentPageId() as string
									if (pageId !== lastPageId) {
										lastPageId = pageId
										notifyPage(pageId)
									}
								},
								{ scope: 'session' }
							)
						},
						// eslint-disable-next-line react-hooks/exhaustive-deps
						[]
					)}
				/>

				{/* Checkpoint history panel — floats over the canvas */}
				{showHistory && (
					<div
						style={{
							pointerEvents: 'all',
							position: 'absolute',
							top: 0,
							right: 0,
							bottom: 0,
							width: 320,
							background: '#fff',
							borderLeft: '1px solid #e0e0e0',
							boxShadow: '-4px 0 16px rgba(0,0,0,0.1)',
							zIndex: 1000,
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						<div
							style={{
								padding: '12px 16px',
								borderBottom: '1px solid #e0e0e0',
								fontWeight: 600,
								fontSize: 14,
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
							}}
						>
							<span>📋 历史快照</span>
							<button
								onClick={() => setShowHistory(false)}
								style={{
									background: 'none',
									border: 'none',
									cursor: 'pointer',
									fontSize: 16,
									color: '#888',
									padding: '0 4px',
								}}
							>
								✕
							</button>
						</div>
						<div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
							{checkpoints.length === 0 ? (
								<p style={{ color: '#888', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
									暂无快照，先点「💾 快照」保存
								</p>
							) : (
								checkpoints.map((cp) => (
									<div
										key={cp.id}
										style={{
											padding: '10px 12px',
											marginBottom: 8,
											background: '#f8fafc',
											borderRadius: 8,
											border: '1px solid #e2e8f0',
										}}
									>
										<div
											style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#1e293b' }}
										>
											{cp.name}
										</div>
										<div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
											{new Date(cp.createdAt).toLocaleString('zh-CN')}
										</div>
										<button
											onClick={() => restoreCheckpoint(cp.id)}
											disabled={restoringId !== null}
											style={{
												background: restoringId === cp.id ? '#94a3b8' : '#6366f1',
												color: 'white',
												border: 'none',
												borderRadius: 5,
												padding: '4px 12px',
												cursor: restoringId !== null ? 'not-allowed' : 'pointer',
												fontSize: 12,
												fontWeight: 600,
											}}
										>
											{restoringId === cp.id ? '恢复中…' : '↩ 恢复'}
										</button>
									</div>
								))
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
