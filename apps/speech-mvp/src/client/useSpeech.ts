import { useCallback, useEffect, useRef, useState } from 'react'

const SERVER = 'http://localhost:5858'

export type SpeechState = 'idle' | 'listening' | 'error' | 'unsupported'

export function useSpeech(roomId: string) {
	const [state, setState] = useState<SpeechState>(() => {
		const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
		return SR ? 'idle' : 'unsupported'
	})

	const recognitionRef = useRef<SpeechRecognition | null>(null)

	const start = useCallback(
		(lang = 'zh-CN') => {
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
				const isFinal = result.isFinal

				try {
					await fetch(`${SERVER}/speech`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ text: transcript, isFinal, roomId }),
					})
				} catch (err) {
					console.error('Speech POST failed', err)
				}
			}

			recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
				console.error('Speech recognition error', e.error)
				setState('error')
			}
			recognition.onend = () => setState('idle')

			recognitionRef.current = recognition
			recognition.start()
			setState('listening')
		},
		[roomId]
	)

	const stop = useCallback(() => {
		recognitionRef.current?.stop()
		setState('idle')
	}, [])

	useEffect(() => () => recognitionRef.current?.stop(), [])

	return { state, start, stop }
}
