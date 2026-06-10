# Speech MVP 开发日志

## 目标

验证「让白板实时长出文字」核心链路：语音输入 / Agent 流式输出 → tldraw 画布实时更新，支持多端实时协作。

## 架构

```
Browser (React + Tldraw)
  ├── Web Speech API → POST /speech
  ├── useSync(ws://localhost:5858/connect/speech-room)
  └── Agent 输入框 → POST /agent (SSE)

Node.js Server (port 5858)
  ├── Fastify + @fastify/websocket
  ├── GET /connect/:roomId   ← tldraw sync WebSocket
  ├── POST /speech           ← 语音写入 TLSocketRoom
  ├── POST /agent            ← OpenAI 流式输出写入 TLSocketRoom
  └── TLSocketRoom → broadcast diff → 所有客户端
```

**关键机制**：`room.storage.transaction()` 写入后，`InMemorySyncStorage` 通过 `MicrotaskNotifier` 在微任务队列里广播 diff patch 给所有 WebSocket session，无需轮询。

## 文件结构

```
apps/speech-mvp/
├── package.json
├── tsconfig.json
├── vite.config.mts
└── src/
    ├── client/
    │   ├── index.html
    │   ├── index.css
    │   ├── main.tsx
    │   ├── App.tsx        ← tldraw 画布 + 控制栏
    │   └── useSpeech.ts   ← Web Speech API hook
    └── server/
        ├── rooms.ts       ← TLSocketRoom 管理 + shape 写入
        └── server.ts      ← Fastify 服务端
```

## 启动

```bash
cd apps/speech-mvp

# mock 模式（无需 OpenAI）
yarn dev

# 真实 OpenAI 流式输出
OPENAI_API_KEY=sk-xxx yarn dev
```

前端：`http://localhost:5760`，后端：`http://localhost:5858`

## 踩坑记录

### 1. tldraw 工具栏不显示

**原因**：缺少 `tldraw/tldraw.css` 导入。  
**错误做法**：在 `index.css` 里用 `@import url('tldraw/tldraw.css')` — PostCSS 不走 Vite 的模块解析，找不到 node_modules。  
**正确做法**：在 `App.tsx` 里加 `import 'tldraw/tldraw.css'`。

### 2. `tldraw/tldraw.css` 不存在

**原因**：这是构建产物（合并了 `editor.css` + `ui.css`），开发模式下需手动生成。  
**修复**：

```bash
node packages/tldraw/scripts/copy-css-files.mjs
```

monorepo 的 `yarn dev` 会自动跑这个脚本，但单独启动 `apps/speech-mvp` 时不会。

### 3. 图片上传报 "upload failed"

**原因**：`TLAssetStore.upload` 直接 `throw new Error`，tldraw 捕获后显示失败。  
**修复**：改为 `FileReader` 转 base64 data URL 内联存储，无需服务端：

```ts
async upload(_asset, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ src: reader.result as string })
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
```

### 4. pre-commit hook 失败

**原因**：`/Users/leoshan/package.json` 存在但缺少 `name` 和 `version` 字段，lazyrepo 向上遍历目录树时校验失败。  
**修复**：在该文件中补全 `"name": "leoshan-home", "version": "1.0.0"`。

### 5. pre-push hook 失败（git-lfs）

**原因**：husky 的 `pre-push` 脚本要求 `git-lfs` 已安装。  
**修复**：`brew install git-lfs`

### 6. 推送 main 被拒绝

**原因**：fork 在创建后自动同步了上游新提交，本地 main 落后。  
**修复**：推到独立分支 `speech-mvp` 而非 main：

```bash
git push leoshan main:speech-mvp
```

## GitHub

- Fork: https://github.com/leoshan/tldraw
- 分支: `speech-mvp`
- Tag: `speech-mvp-v0.1.0`

## 后续扩展方向

- 替换 Web Speech API 为 Whisper WebSocket 流（延迟更低，支持非 Chrome）
- 文字卡片排版：根据 viewport 尺寸自动分列

---

## Session 2026-06-08：SQLite 持久化、多房间/多页面、文件 IO 完善、UI 重组

### SQLite 持久化（Issue #6）

将 `InMemorySyncStorage` 替换为 `NodeSqliteSyncWrapper`（tldraw 官方 sync-core 内置），每个 roomId 对应 `data/rooms/{roomId}.db` 文件。服务重启后画布状态完整恢复。

同时新增 `speech_mvp_checkpoints` 表，存储手动时间点快照：

```
GET  /rooms/:roomId/checkpoints       → { checkpoints: [{ id, createdAt }] }
POST /rooms/:roomId/checkpoints       → 保存当前快照
GET  /rooms/:roomId/checkpoints/:id   → 返回完整快照 JSON
```

### 快照历史 UI 面板

控制栏新增"📋 历史"按钮，点击后右侧滑出历史面板，列出所有保存的快照（时间戳排列）。点击任意快照调用 `editor.loadSnapshot()` 恢复白板状态。

**坑**：服务端返回 `{ checkpoints: [] }` 对象，而不是裸数组。客户端直接 `setCheckpoints(data)` 后调用 `.map()` 会 TypeError，导致 React 组件崩溃白屏。修复：改为 `setCheckpoints(data.checkpoints ?? [])`。

### .tldr 文件导出/导入修复

**导出**：`editor.getStoreSnapshot()` 已重命名为 `editor.getSnapshot()`，但它返回 `TLEditorSnapshot`（含 `document` 和 `session` 字段），不是 tldraw VSCode 插件识别的 `TldrawFile` 格式。正确做法是用 `await serializeTldrawJson(editor)`，该函数返回标准 `{ tldrawFileFormatVersion, schema, records[] }` JSON。

**导入**：历史 `.tldr` 文件存在三种格式（裸 `records[]`、`document.store` 对象、`store` 对象），需逐一探测：

```typescript
const records = parsed.records ?? parsed.document?.store ?? parsed.store
```

然后调用 `editor.store.mergeRemoteChanges(() => { for (const r of records) editor.store.put([r]) })`。

### 多页面支持

核心问题：服务端所有 shape 工厂函数写死 `parentId: 'page:page'`，在多页面场景下形状只会出现在第一页。

**解决方案**：

- `rooms.ts` 新增 `roomActivePageId = new Map<string, string>()` 和 `activePage(roomId)` helper
- 客户端 `onMount` 监听 `editor.store.listen({ scope: 'session' })`，检测 `getCurrentPageId()` 变化时 `POST /rooms/:roomId/active-page { pageId }` 通知服务端
- 所有 shape 工厂函数签名改为首参 `roomId: string`，`parentId` 统一使用 `activePage(roomId) as TLParentId`

### 多房间支持

- URL 参数 `?room=xxx` 指定房间，默认 `speech-room`
- `GET /rooms` 接口：`readdirSync('data/rooms')` 读取所有 `.db` 文件，附 `mtime` 排序
- 客户端房间选择器：下拉面板列出所有历史房间 + 最近访问时间，当前房间高亮，点击直接跳转

### 工具栏重组

将散乱按钮整理为 4 个语义分组，以竖线分隔：

```
[🎤 语音] [🔊 系统音频] [⬇ 转写] | [📷 截图] [🖼 上传] | [💬 发送] [🗂 标注] | [💾 保存] [📋 历史] [⬆ 导出] [⬇ 导入]
```

"标注摘要"从独立按钮移入 Agent 分组（发送按钮旁边），减少认知负担。

### 截图后焦点修复

调用 `getDisplayMedia()` 后，用户选择了要捕获的标签页，焦点会停留在被截图的窗口。修复：在 `stream = await navigator.mediaDevices.getDisplayMedia(...)` 之后立即调用 `window.focus()`，将焦点拉回 app 标签页。

### 视觉摘要可读性修复

图片分析产生的摘要 shape 原先使用 `size: 's', scale: 0.5`（~9px 字体），实际上难以阅读。改为 `size: 'm', scale: 1`（~24px），同时将 shape 最小宽度设为 400px。

同时修复 OCR shape 垂直偏移计算：原来按 11px/行估算高度，改为与实际字体大小匹配的 14px/字符宽、30px/行高，并加 24px 间距，避免摘要和 OCR 文本框重叠。

### 踩坑：TypeScript 类型错误

- `room.storage.getSnapshot()` 类型上返回值可能 undefined，需 cast to `any`
- `map((d) =>` 中 `d` 隐含 `any` 类型报错，需显式标注 `: any`
- `editor.store.listen` session 作用域监听不能通过 `entry.changes.updated` 检测页面变化（key 类型不兼容），改为直接对比 `getCurrentPageId()` 前后差值

### 踩坑：git push 非快进

本地在 `speech-mvp` 分支，误用 `git push leoshan main:speech-mvp`，正确命令：

```bash
git push leoshan speech-mvp
```
