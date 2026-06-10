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
	const activeRef = useRef(false)
	const capturedIdsRef = useRef<string[]>([])
	const silentChunksRef = useRef(0)

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
			try {
				const res = await fetch(`${SERVER}/transcribe`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						audio,
						mimeType: blob.type,
						roomId,
						...(pos && { x: pos.x, y: pos.y }),
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
		streamRef.current?.getTracks().forEach((t) => t.stop())
		streamRef.current = null
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

	const start = useCallback(async () => {
		try {
			// Chrome requires a video constraint; request minimal video then stop it immediately.
			// macOS: audio capture only works when sharing a Chrome Tab with "Share audio" checked.
			const displayStream = await navigator.mediaDevices.getDisplayMedia({
				audio: true,
				video: { width: 1, height: 1 },
			})
			displayStream.getVideoTracks().forEach((t) => t.stop())

			const audioTracks = displayStream.getAudioTracks()
			if (audioTracks.length === 0) {
				// No audio track — user likely shared a screen/window rather than a tab,
				// or didn't check "Share audio" in the Chrome picker.
				setState('no_audio')
				return
			}

			const audioStream = new MediaStream(audioTracks)
			streamRef.current = audioStream
			capturedIdsRef.current = []
			silentChunksRef.current = 0
			setChunkCount(0)
			activeRef.current = true
			setState('capturing')

			audioTracks[0].addEventListener('ended', () => stop(), { once: true })
			recordChunkRef.current?.(audioStream)
		} catch (err: any) {
			if (err.name !== 'NotAllowedError') setState('error')
			// NotAllowedError = user dismissed the picker — stay idle
		}
	}, [stop])

	useEffect(
		() => () => {
			activeRef.current = false
			streamRef.current?.getTracks().forEach((t) => t.stop())
		},
		[]
	)

	return { state, chunkCount, start, stop }
}
