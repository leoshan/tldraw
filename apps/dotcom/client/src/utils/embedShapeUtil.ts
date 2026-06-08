import { EmbedShapeUtil } from 'tldraw'

// The Google Maps API key is public (it ships to the browser); it's protected by
// HTTP referrer restrictions and quotas on the key itself, not by how it's injected.
// vite inlines this NEXT_PUBLIC_ var at build time.
const googleMapsApiKey = process.env.NEXT_PUBLIC_GC_API_KEY

// Replaces the default embed shape util so tldraw.com's Google Maps embeds get an API key.
// `<Tldraw>` merges these with the defaults by type, so only the embed util is overridden.
// Defined at module scope so the array keeps a stable identity across renders.
export const embedShapeUtils = [
	EmbedShapeUtil.configure({ embedConfig: { google_maps: { apiKey: googleMapsApiKey } } }),
]
