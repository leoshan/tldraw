/// <reference types="vitest" />
import { mergeConfig } from 'vitest/config'
import baseConfig from '../../../internal/config/vitest/node-preset'

// zero-cache holds the postgres migrations; its tests run in a Node environment and
// talk to a real postgres (see delete_file_states.test.ts).
export default mergeConfig(baseConfig, {
	test: {
		environment: 'node',
		// zero-cache keeps its sources at the package root (migrations/, migrate.ts),
		// not under src/, so widen the default include to find tests here.
		include: ['**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
})
