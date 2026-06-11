import { useCallback, useEffect, useRef, useState } from 'react'

const SERVER = 'http://localhost:5858'
const CHUNK_MS = 5_000

export type SpeechState = 'idle' | 'listening' | 'error' | 'unsupported'
export type SpeechMode = 'webspeech' | 'stt'
export interface ClickPos {
	x: number
	y: number
}

export function useSpeech(roomId: string, positionRef: React.RefObject<ClickPos | null>) {
	const [state, setState] = useState<SpeechState>('idle')

	// Web Speech refs
	const recognitionRef = useRef<SpeechRecognition | null>(null)

	// STT (getUserMedia) refs
	const streamRef = useRef<MediaStream | null>(null)
	const activeRef = useRef(false)

	// Tracks which mode is currently running so stop() knows what to tear down
	const activeModeRef = useRef<SpeechMode | null>(null)

	// ── STT helpers ────────────────────────────────────────────────────────────

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
			if (blob.size < 500) return
			const audio = await blobToBase64(blob)
			const pos = positionRef.current
			try {
				await fetch(`${SERVER}/transcribe`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						audio,
						mimeType: blob.type,
						roomId,
						...(pos && { x: pos.x, y: pos.y }),
					}),
				})
			} catch (err) {
				console.error('Transcribe failed', err)
			}
		},
		[roomId, positionRef]
	)

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

	// ── stop ───────────────────────────────────────────────────────────────────

	const stop = useCallback(() => {
		const mode = activeModeRef.current
		activeModeRef.current = null

		if (mode === 'webspeech') {
			recognitionRef.current?.stop()
			recognitionRef.current = null
		} else if (mode === 'stt') {
			if (!activeRef.current) return
			activeRef.current = false
			streamRef.current?.getTracks().forEach((t) => t.stop())
			streamRef.current = null
		}
		setState('idle')
	}, [])

	// ── start ──────────────────────────────────────────────────────────────────

	const start = useCallback(
		async (lang = 'zh-CN', mode: SpeechMode = 'stt') => {
			if (mode === 'webspeech') {
				const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
				if (!SR) {
					setState('unsupported')
					return
				}

				const recognition: SpeechRecognition = new SR()
				recognition.continuous = true
				recognition.interimResults = true
				recognition.lang = lang

				recognition.onresult = async (event: SpeechRecognitionEvent) => {
					const result = event.results[event.results.length - 1]
					const transcript = result[0].transcript.trim()
					if (!transcript) return
					const pos = positionRef.current
					try {
						await fetch(`${SERVER}/speech`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								text: transcript,
								isFinal: result.isFinal,
								roomId,
								...(pos && { x: pos.x, y: pos.y }),
							}),
						})
					} catch (err) {
						console.error('Speech POST failed', err)
					}
				}

				recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
					console.error('Speech recognition error', e.error)
					setState('error')
				}
				recognition.onend = () => {
					// Only reset to idle if this recognition instance is still the active one
					if (activeModeRef.current === 'webspeech') {
						activeModeRef.current = null
						setState('idle')
					}
				}

				recognitionRef.current = recognition
				activeModeRef.current = 'webspeech'
				recognition.start()
				setState('listening')
			} else {
				// mode === 'stt'
				if (!navigator?.mediaDevices?.getUserMedia) {
					setState('unsupported')
					return
				}
				try {
					const audioStream = await navigator.mediaDevices.getUserMedia({
						audio: true,
						video: false,
					})
					streamRef.current = audioStream
					activeRef.current = true
					activeModeRef.current = 'stt'
					setState('listening')
					audioStream.getAudioTracks()[0]?.addEventListener('ended', () => stop(), {
						once: true,
					})
					recordChunkRef.current?.(audioStream)
				} catch (err: any) {
					if (err.name !== 'NotAllowedError') setState('error')
				}
			}
		},
		[roomId, positionRef, stop]
	)

	// ── cleanup on unmount ─────────────────────────────────────────────────────

	useEffect(
		() => () => {
			recognitionRef.current?.stop()
			activeRef.current = false
			streamRef.current?.getTracks().forEach((t) => t.stop())
		},
		[]
	)

	return { state, start, stop }
}
