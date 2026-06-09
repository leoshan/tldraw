import { useCallback, useRef, useState } from 'react'
import type { ClickPos } from './useSpeech'

const SERVER = 'http://localhost:5858'

export type ScreenCaptureState = 'idle' | 'capturing' | 'uploading' | 'error'

export interface UseScreenCaptureReturn {
	state: ScreenCaptureState
	/** Capture a screenshot via getDisplayMedia, then POST /vision */
	captureScreen(): Promise<void>
	/** Upload an image File, then POST /vision */
	uploadImage(file: File): Promise<void>
}

export function useScreenCapture(
	roomId: string,
	positionRef: React.RefObject<ClickPos | null>
): UseScreenCaptureReturn {
	const [state, setState] = useState<ScreenCaptureState>('idle')
	// Prevent double-submit while a request is in flight
	const inflightRef = useRef(false)

	// ── Core: send an image blob/base64 to /vision and drain the SSE stream ──
	const sendToVision = useCallback(
		async (base64: string, mimeType: string, w: number, h: number) => {
			if (inflightRef.current) return
			inflightRef.current = true
			setState('uploading')
			const pos = positionRef.current
			try {
				const resp = await fetch(`${SERVER}/vision`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						image: base64,
						mimeType,
						roomId,
						w,
						h,
						...(pos && { x: pos.x, y: pos.y }),
					}),
				})
				// Drain the SSE stream so the server flushes completely
				if (resp.body) {
					const reader = resp.body.getReader()
					while (true) {
						const { done } = await reader.read()
						if (done) break
					}
				}
			} finally {
				inflightRef.current = false
				setState('idle')
			}
		},
		[roomId, positionRef]
	)

	// ── Screenshot via getDisplayMedia ──────────────────────────────────────────
	const captureScreen = useCallback(async () => {
		if (inflightRef.current) return
		setState('capturing')
		try {
			// Request a full-screen stream
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: { frameRate: 1 },
				audio: false,
			})

			const track = stream.getVideoTracks()[0]
			const settings = track.getSettings()
			const frameW = settings.width ?? 1280
			const frameH = settings.height ?? 720

			// Capture one frame to a canvas
			// ImageCapture is the cleanest API but isn't in all TypeScript libs;
			// use video-element approach as fallback for broader compatibility.
			const canvas = document.createElement('canvas')
			canvas.width = frameW
			canvas.height = frameH
			const ctx = canvas.getContext('2d')!

			await new Promise<void>((resolve, reject) => {
				const video = document.createElement('video')
				video.muted = true
				video.srcObject = stream
				video.onloadedmetadata = () => {
					video.play().then(() => {
						// Give the video one frame to render
						requestAnimationFrame(() => {
							ctx.drawImage(video, 0, 0, frameW, frameH)
							stream.getTracks().forEach((t) => t.stop())
							resolve()
						})
					}, reject)
				}
				video.onerror = reject
			})

			// Extract base64 (strip data: prefix)
			const dataUrl = canvas.toDataURL('image/png')
			const base64 = dataUrl.split(',')[1]
			await sendToVision(base64, 'image/png', frameW, frameH)
		} catch (err: any) {
			if (err.name === 'NotAllowedError') {
				// User cancelled — go back to idle silently
				setState('idle')
			} else {
				console.error('Screen capture failed', err)
				setState('error')
				setTimeout(() => setState('idle'), 3000)
			}
		}
	}, [sendToVision])

	// ── File upload ──────────────────────────────────────────────────────────────
	const uploadImage = useCallback(
		async (file: File) => {
			if (inflightRef.current) return
			setState('uploading')
			try {
				// Get native image dimensions
				const { base64, w, h } = await new Promise<{ base64: string; w: number; h: number }>(
					(resolve, reject) => {
						const reader = new FileReader()
						reader.onload = () => {
							const dataUrl = reader.result as string
							const img = new Image()
							img.onload = () =>
								resolve({
									base64: dataUrl.split(',')[1],
									w: img.naturalWidth,
									h: img.naturalHeight,
								})
							img.onerror = reject
							img.src = dataUrl
						}
						reader.onerror = reject
						reader.readAsDataURL(file)
					}
				)
				await sendToVision(base64, file.type || 'image/png', w, h)
			} catch (err) {
				console.error('Image upload failed', err)
				setState('error')
				setTimeout(() => setState('idle'), 3000)
			}
		},
		[sendToVision]
	)

	return { state, captureScreen, uploadImage }
}
