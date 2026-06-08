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
- 持久化：替换 `InMemorySyncStorage` 为 `NodeSqliteSyncWrapper`
- 多 room 支持：URL 参数 `?room=xxx`
- 文字卡片排版：根据 viewport 尺寸自动分列
