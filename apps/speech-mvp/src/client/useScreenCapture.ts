import { useCallback, useRef, useState } from 'react'
import type { ClickPos } from './useSpeech'

const SERVER = 'http://localhost:5858'

export type ScreenCaptureState = 'idle' | 'picking' | 'capturing' | 'uploading' | 'error'

export interface UseScreenCaptureReturn {
	state: ScreenCaptureState
	captureScreen(): Promise<void>
	uploadImage(file: File): Promise<void>
}

export function useScreenCapture(
	roomId: string,
	positionRef: React.RefObject<ClickPos | null>
): UseScreenCaptureReturn {
	const [state, setState] = useState<ScreenCaptureState>('idle')
	const inflightRef = useRef(false)

	// ── Core: POST base64 image to /vision and drain the SSE stream ──────────
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

	// ── Capture one frame from a MediaStreamTrack ─────────────────────────────
	// Strategy 1 (preferred): ImageCapture.grabFrame() — designed for single-frame
	//   capture, works even when the page is in the background.
	// Strategy 2 (fallback): video element with readyState polling.
	const grabFrame = useCallback(
		async (stream: MediaStream): Promise<{ base64: string; w: number; h: number }> => {
			const track = stream.getVideoTracks()[0]

			// ── Strategy 1: ImageCapture API ──────────────────────────────────
			if (typeof (globalThis as any).ImageCapture !== 'undefined') {
				const imageCapture = new (globalThis as any).ImageCapture(track)
				const bitmap: ImageBitmap = await imageCapture.grabFrame()
				const { width: w, height: h } = bitmap
				const canvas = document.createElement('canvas')
				canvas.width = w
				canvas.height = h
				canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
				bitmap.close()
				stream.getTracks().forEach((t) => t.stop())
				const dataUrl = canvas.toDataURL('image/png')
				return { base64: dataUrl.split(',')[1], w, h }
			}

			// ── Strategy 2: Video element with readyState polling ─────────────
			return new Promise((resolve, reject) => {
				const settings = track.getSettings()
				const frameW = settings.width ?? 1280
				const frameH = settings.height ?? 720

				const canvas = document.createElement('canvas')
				canvas.width = frameW
				canvas.height = frameH
				const ctx = canvas.getContext('2d')!

				const video = document.createElement('video')
				video.muted = true
				video.playsInline = true
				video.srcObject = stream

				// Poll until the video has actual decoded frame data
				const tryCapture = () => {
					if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
						ctx.drawImage(video, 0, 0, frameW, frameH)
						stream.getTracks().forEach((t) => t.stop())
						const dataUrl = canvas.toDataURL('image/png')
						resolve({ base64: dataUrl.split(',')[1], w: frameW, h: frameH })
					} else {
						requestAnimationFrame(tryCapture)
					}
				}

				video.oncanplay = () => {
					video.play().then(() => requestAnimationFrame(tryCapture), reject)
				}
				video.onerror = reject
			})
		},
		[]
	)

	// ── Screenshot via getDisplayMedia ────────────────────────────────────────
	const captureScreen = useCallback(async () => {
		if (inflightRef.current) return

		// 'picking': browser dialog is open, waiting for user to select a window
		setState('picking')
		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getDisplayMedia({
				video: { frameRate: 1 },
				audio: false,
			})
		} catch (err: any) {
			// User dismissed the picker — return to idle silently
			if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
				setState('idle')
			} else {
				console.error('getDisplayMedia failed', err)
				setState('error')
				setTimeout(() => setState('idle'), 3000)
			}
			return
		}

		// 'capturing': user picked a window, now extracting the frame
		setState('capturing')
		try {
			const { base64, w, h } = await grabFrame(stream)

			// Sanity check: reject blank (all-black) frames
			if (!base64 || base64.length < 500) {
				throw new Error('Captured frame appears to be blank')
			}

			await sendToVision(base64, 'image/png', w, h)
		} catch (err) {
			console.error('Screen capture failed', err)
			// Stop any remaining tracks
			stream.getTracks().forEach((t) => t.stop())
			setState('error')
			setTimeout(() => setState('idle'), 3000)
		}
	}, [grabFrame, sendToVision])

	// ── File upload ───────────────────────────────────────────────────────────
	const uploadImage = useCallback(
		async (file: File) => {
			if (inflightRef.current) return
			setState('uploading')
			try {
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
