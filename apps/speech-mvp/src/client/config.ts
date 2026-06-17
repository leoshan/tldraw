const getBackendUrl = () => {
	const envUrl = (import.meta as any).env?.VITE_SERVER_URL
	if (envUrl) return envUrl
	// Dynamically fallback to the hostname of the page that served this frontend on port 5858
	const protocol = window.location.protocol
	const hostname = window.location.hostname
	return `${protocol}//${hostname}:5858`
}

export const SERVER = getBackendUrl()
export const WS_SERVER = SERVER.replace(/^http/, 'ws')
