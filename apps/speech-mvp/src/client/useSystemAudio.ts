import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClickPos } from './useSpeech'

const SERVER = 'http://localhost:5858'
const CHUNK_MS = 10_000

export type SystemAudioState = 'idle' | 'capturing' | 'error' | 'unsupported'

export function useSystemAudio(roomId: string, positionRef: React.RefObject<ClickPos | null>) {
	const [state, setState] = useState<SystemAudioState>(() =>
		typeof navigator?.mediaDevices?.getDisplayMedia === 'function' ? 'idle' : 'unsupported'
	)

	const streamRef = useRef<MediaStream | null>(null)
	const activeRef = useRef(false)
	const capturedIdsRef = useRef<string[]>([])

	// Convert a Blob to base64 (strips the data: prefix)
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
			// Skip near-silent or empty chunks (header-only WebM is ~300 bytes)
			if (blob.size < 1500) return
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
				if (data.shapeId) capturedIdsRef.current.push(data.shapeId)
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
			// Chrome requires a video constraint; request minimal video then stop it immediately
			const displayStream = await navigator.mediaDevices.getDisplayMedia({
				audio: true,
				video: { width: 1, height: 1 },
			})
			displayStream.getVideoTracks().forEach((t) => t.stop())

			const audioTracks = displayStream.getAudioTracks()
			if (audioTracks.length === 0) {
				setState('error')
				return
			}

			const audioStream = new MediaStream(audioTracks)
			streamRef.current = audioStream
			capturedIdsRef.current = []
			activeRef.current = true
			setState('capturing')

			// Stop capturing when the user closes the browser share dialog
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

	return { state, start, stop }
}
