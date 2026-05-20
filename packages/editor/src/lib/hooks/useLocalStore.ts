import { TLAsset, TLAssetStore, TLStoreSnapshot } from '@tldraw/tlschema'
import { WeakCache } from '@tldraw/utils'
import { useEffect, useRef } from 'react'
import { TLStoreOptions, createTLStore } from '../config/createTLStore'
import { TLEditorSnapshot } from '../config/TLEditorSnapshot'
import { TLStoreWithStatus } from '../utils/sync/StoreWithStatus'
import { TLLocalSyncClient } from '../utils/sync/TLLocalSyncClient'
import { useShallowObjectIdentity } from './useIdentity'
import { useRefState } from './useRefState'

/** @internal */
export function useLocalStore(
	options: {
		persistenceKey?: string
		sessionId?: string
		snapshot?: TLEditorSnapshot | TLStoreSnapshot
	} & TLStoreOptions
): TLStoreWithStatus {
	const [state, setState] = useRefState<TLStoreWithStatus>({ status: 'loading' })

	// Themes can change at runtime (e.g. when adjusting display values like fontSize)
	// but the store doesn't need to be recreated when they do — runtime updates flow
	// through editor.updateTheme(). Hold the latest themes in a ref so we pick them
	// up on initial store creation without re-running the effect on every change.
	const themesRef = useRef(options.themes)
	themesRef.current = options.themes

	const { themes: _themes, ...optionsWithoutThemes } = options
	const stableOptions = useShallowObjectIdentity(optionsWithoutThemes)

	useEffect(() => {
		const { persistenceKey, sessionId, ...rest } = stableOptions
		const themes = themesRef.current

		if (!persistenceKey) {
			setState({
				status: 'not-synced',
				store: createTLStore({ ...rest, themes }),
			})
			return
		}

		setState({ status: 'loading' })

		const objectURLCache = new WeakCache<TLAsset, Promise<string | null>>()
		const assets: TLAssetStore = {
			upload: async (asset, file) => {
				await client.db.storeAsset(asset.id, file)
				return { src: asset.id }
			},
			resolve: async (asset) => {
				if (!asset.props.src) return null

				if (asset.props.src.startsWith('asset:')) {
					return await objectURLCache.get(asset, async () => {
						const blob = await client.db.getAsset(asset.id)
						if (!blob) return null
						return URL.createObjectURL(blob)
					})
				}

				return asset.props.src
			},
			remove: async (assetIds) => {
				await client.db.removeAssets(assetIds)
			},
			...rest.assets,
		}

		const store = createTLStore({ ...rest, themes, assets })

		let isClosed = false

		const client = new TLLocalSyncClient(store, {
			sessionId,
			persistenceKey,
			onLoad() {
				if (isClosed) return
				setState({ store, status: 'synced-local' })
			},
			onLoadError(err: any) {
				if (isClosed) return
				setState({ status: 'error', error: err })
			},
		})

		return () => {
			isClosed = true
			client.close()
		}
	}, [stableOptions, setState])

	return state
}
