import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClickPos } from './useSpeech'

const SERVER = 'http://localhost:5858'
const CHUNK_MS = 10_000
// Consecutive silent chunks before we surface a 'no_audio' warning
const SILENT_CHUNK_LIMIT = 2

export type SystemAudioState = 'idle' | 'capturing' | 'no_audio' | 'error' | 'unsupported'

export function useSystemAudio(roomId: string, positionRef: React.RefObject<ClickPos | null>) {
	const [state, setState] = useState<SystemAudioState>(() =>
		typeof navigator?.mediaDevices?.getDisplayMedia === 'function' ? 'idle' : 'unsupported'
	)
	// How many chunks have been successfully sent this session
	const [chunkCount, setChunkCount] = useState(0)

	const streamRef = useRef<MediaStream | null>(null)
	const systemStreamRef = useRef<MediaStream | null>(null)
	const micStreamRef = useRef<MediaStream | null>(null)
	const audioContextRef = useRef<AudioContext | null>(null)
	const activeRef = useRef(false)
	const capturedIdsRef = useRef<string[]>([])
	const silentChunksRef = useRef(0)

	// Page locked at recording start — all shapes go here regardless of later page switches
	const lockedPageIdRef = useRef<string | null>(null)

	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve((reader.result as string).split(',')[1])
			reader.onerror = reject
			reader.readAsDataURL(blob)
		})
	}

	const sendChunk = useCallback(
		async (blob: Blob) => {
			// Header-only WebM (no audio data) is typically < 500 bytes.
			// Use a conservative 500-byte floor instead of 1500 to avoid dropping
			// low-bitrate or short-speech chunks.
			if (blob.size < 500) {
				silentChunksRef.current += 1
				if (silentChunksRef.current >= SILENT_CHUNK_LIMIT && activeRef.current) {
					setState('no_audio')
				}
				return
			}
			silentChunksRef.current = 0
			if (activeRef.current) setState('capturing')

			const audio = await blobToBase64(blob)
			const pos = positionRef.current
			const pageId = lockedPageIdRef.current
			try {
				const res = await fetch(`${SERVER}/transcribe`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						audio,
						mimeType: blob.type,
						roomId,
						...(pos && { x: pos.x, y: pos.y }),
						...(pageId && { pageId }),
					}),
				})
				const data = await res.json()
				if (data.shapeId) {
					capturedIdsRef.current.push(data.shapeId)
					setChunkCount((n) => n + 1)
				}
			} catch (err) {
				console.error('Transcribe failed', err)
			}
		},
		[roomId, positionRef]
	)

	// Rolling recorder: starts a new MediaRecorder every CHUNK_MS ms.
	// Each recorder produces one complete WebM file so Whisper can decode it.
	const recordChunkRef = useRef<((s: MediaStream) => void) | null>(null)

	useEffect(() => {
		recordChunkRef.current = (audioStream: MediaStream) => {
			if (!activeRef.current) return
			const recorder = new MediaRecorder(audioStream)
			const parts: BlobPart[] = []
			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) parts.push(e.data)
			}
			recorder.onstop = async () => {
				const blob = new Blob(parts, { type: recorder.mimeType })
				await sendChunk(blob)
				recordChunkRef.current?.(audioStream)
			}
			recorder.start()
			setTimeout(() => {
				if (recorder.state === 'recording') recorder.stop()
			}, CHUNK_MS)
		}
	}, [sendChunk])

	const stop = useCallback(async () => {
		if (!activeRef.current) return
		activeRef.current = false
		lockedPageIdRef.current = null

		// Stop mixed stream
		streamRef.current?.getTracks().forEach((t) => t.stop())
		streamRef.current = null

		// Stop original system display stream
		systemStreamRef.current?.getTracks().forEach((t) => t.stop())
		systemStreamRef.current = null

		// Stop original mic stream
		micStreamRef.current?.getTracks().forEach((t) => t.stop())
		micStreamRef.current = null

		// Close AudioContext
		if (audioContextRef.current) {
			audioContextRef.current.close().catch(console.error)
			audioContextRef.current = null
		}

		silentChunksRef.current = 0
		setChunkCount(0)
		setState('idle')

		// Auto-annotate all segments captured in this session
		const ids = capturedIdsRef.current.slice()
		capturedIdsRef.current = []
		if (ids.length >= 2) {
			try {
				await fetch(`${SERVER}/annotate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ roomId, shapeIds: ids }),
				})
			} catch (err) {
				console.error('Auto-annotate failed', err)
			}
		}
	}, [roomId])

	const start = useCallback(
		async (pageId?: string) => {
			lockedPageIdRef.current = pageId ?? null
			try {
				// 1. Get system audio from display media
				// Chrome requires a video constraint; request minimal video then stop it immediately.
				// macOS: audio capture only works when sharing a Chrome Tab with "Share audio" checked.
				const displayStream = await navigator.mediaDevices.getDisplayMedia({
					audio: true,
					video: { width: 1, height: 1 },
				})
				displayStream.getVideoTracks().forEach((t) => t.stop())

				const systemTracks = displayStream.getAudioTracks()
				if (systemTracks.length === 0) {
					setState('no_audio')
					return
				}

				// 2. Get user microphone audio
				let micStream: MediaStream | null = null
				try {
					micStream = await navigator.mediaDevices.getUserMedia({
						audio: true,
						video: false,
					})
				} catch (micErr) {
					console.warn('Microphone access denied or failed, recording system audio only', micErr)
				}

				let finalStream: MediaStream
				if (micStream && micStream.getAudioTracks().length > 0) {
					// 3. Mix streams using Web Audio API
					const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
					audioContextRef.current = audioContext

					const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemTracks))
					const micSource = audioContext.createMediaStreamSource(micStream)
					const destination = audioContext.createMediaStreamDestination()

					systemSource.connect(destination)
					micSource.connect(destination)

					finalStream = destination.stream
					micStreamRef.current = micStream
				} else {
					// Fallback to only system audio
					finalStream = new MediaStream(systemTracks)
				}

				streamRef.current = finalStream
				systemStreamRef.current = displayStream

				capturedIdsRef.current = []
				silentChunksRef.current = 0
				setChunkCount(0)
				activeRef.current = true
				setState('capturing')

				systemTracks[0].addEventListener('ended', () => stop(), { once: true })
				recordChunkRef.current?.(finalStream)
			} catch (err: any) {
				if (err.name !== 'NotAllowedError') setState('error')
			}
		},
		[stop]
	)

	useEffect(
		() => () => {
			activeRef.current = false
			streamRef.current?.getTracks().forEach((t) => t.stop())
			systemStreamRef.current?.getTracks().forEach((t) => t.stop())
			micStreamRef.current?.getTracks().forEach((t) => t.stop())
			if (audioContextRef.current) {
				audioContextRef.current.close().catch(console.error)
			}
		},
		[]
	)

	return { state, chunkCount, start, stop }
}
