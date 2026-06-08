# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Additional notes for Claude Code

### Editor class

`packages/editor/src/lib/editor/Editor.ts` is ~11,600 lines — the single monolithic editor class and primary public API surface. When working with editor behavior, use grep to find the relevant method rather than reading the file linearly.

### Geometry primitives

`Vec`, `Box`, and `Mat` in `packages/editor/src/lib/primitives/` are the core math types used throughout the editor. Prefer these over ad hoc geometry.

### State primitives

`@tldraw/state` exports `atom`, `computed`, `react`, and `transact`. All reactive editor state derives from these; avoid reading or writing state outside a reactive context.

### Additional validation commands

- `yarn check-packages` — verify workspace package structure
- `yarn check-circular-deps` — detect circular imports across packages

Run these after changes that touch cross-package imports or package manifests.
