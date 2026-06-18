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

**关键机制**：`room.storage.transaction()` 写入后，`SQLiteSyncStorage`（早期为 `InMemorySyncStorage`）在写入的同时通过 `TLSocketRoom` 广播 diff patch 给所有 WebSocket session，无需轮询。

## 文件结构

```
apps/speech-mvp/
├── package.json
├── tsconfig.json
├── vite.config.mts
├── realtime_server.py        ← SenseVoice WebSocket 流式 ASR（自部署）
├── win-capture-helper.ps1    ← Windows 按窗口标题截图助手（:9999）
├── run-helper.bat            ← 启动上面的 PowerShell 助手
└── src/
    ├── client/
    │   ├── index.html
    │   ├── index.css
    │   ├── main.tsx
    │   ├── config.ts          ← 后端地址解析（VITE_SERVER_URL / 页面 hostname）
    │   ├── App.tsx            ← tldraw 画布 + 控制栏
    │   ├── useSpeech.ts       ← 麦克风：Web Speech API + STT provider 双模 + VAD
    │   ├── useSystemAudio.ts  ← 系统音频采集 + 麦克风混音 + 滚动分片
    │   └── useScreenCapture.ts← 截图 / 上传 / Windows 窗口截图
    └── server/
        ├── rooms.ts           ← TLSocketRoom 管理 + shape 工厂 + SQLite
        ├── server.ts          ← Fastify 服务端（全部 HTTP/WS 端点）
        ├── chat.ts            ← Chat provider 抽象（OpenAI / Ollama）
        ├── stt.ts             ← STT provider 抽象（Whisper / SenseVoice）
        ├── vision.ts          ← Vision provider 抽象（GPT-4o / Ollama）
        └── transcript.ts      ← 全量转写 JSONL 文件读写
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

---

## Session 2026-06-11：语音断句与混音录制优化、跨页纪要导出、全局衬线字体应用、框选标注优化

### 语音断句与 VAD 调优

- **问题**：原先的 ASR 在白板上打字速度虽然可以，但由于固定超时时间太短，句子经常断得很碎。
- **优化**：在 `useSystemAudio.ts` 中引入 Web Audio API 实现 RMS 能量动态检测，对齐工业级语音 VAD 标准。将 `silenceTimeout` 调整为更合理的 `1000ms`，使得正常讲话时的语义断句更加完整自然。

### 会议系统音频与麦克风实时混音录制

- **重构**：为了在录制会议系统音频的同时也录下发言者自己的声音，重构了 `useSystemAudio.ts`。
- **机制**：通过 `AudioContext` 将 `getDisplayMedia` 获取的系统音轨与 `getUserMedia` 获取的麦克风音轨创建 `MediaStreamAudioSourceNode` 进行混音，最终混合为一个单声道流传给 ASR。

### 阶段性摘要去重

- **修复**：滑动窗口摘要有时会出现大量重复内容。
- **修复方案**：在 `rooms.ts` 中的 `resetCharCount` 触发滑动摘要后，强制将当前语音临时累加的缓冲清空，彻底解决了摘要内容的前后重叠问题。

### 按页面隔离的摘要导出与会议纪要提炼

- **摘要导出**：新增 `GET /rooms/:roomId/summaries` 接口，仅拉取当前活跃页（由 `parentId` 区分）的橙色摘要卡片内容，以 Markdown 列表格式导出。
- **会议纪要流式生成**：新增 `POST /rooms/:roomId/minutes` 接口，汇总当前页面摘要并调用大模型提炼，流式（SSE）写入新建的蓝色 `MinutesCard` 卡片。
- **本地自动备份**：提炼出的会议纪要会自动在本地 `/root/recorder/minutes/` 目录下保存为带有房间号和时间戳的 `.md` 文件。
- **动态位置排版**：会议纪要卡片不再放置在固定坐位，而是扫描当前页面的所有图形以计算出最大的底部边界 $MaxY$，自动将其生成在当前内容下方（`y = MaxY + 60`），并下推 roomYOffsets 游标防止覆盖。

### 全局衬线字体（Serif）样式定制

- **重构**：通过在 `index.css` 中以 `!important` 覆盖 tldraw 的内部字体变量（`--tl-font-ui`, `--tl-font-sans`, `--tl-font-draw`, etc.），将白板画布中所有生成的便签卡片一并改造成具有出版品质感的衬线字体（Georgia）。
- **控件还原**：保持顶部控制栏、下拉菜单和输入框为无衬线字体以确保标准 UI 的清晰易读。

### 框选标注多模态流式升级与边界优化

- **多模态总结**：重构 `/annotate` 接口，通过 `getSelectedContent` 提取框选区域内的纯文本和 Base64 图片资产，调用大模型进行流式总结并更新至框外的橙色 `SummaryCard`。
- **文本格式净化**：大模型提示词中明确禁止输出 Markdown 字符，仅使用换行自然分段。
- **精确边界虚线框**：优化了 text 形状在服务端的边界高度预测（根据字符数与卡片宽计算折行数），解决了多行框选时虚线框切掉部分文字底部的问题。

---

## Session 2026-06-12 ~ 06-18：双模语音、标注精简、多模态编排、Windows 窗口截图、远程部署

### 麦克风双模输入 + 客户端 VAD + SenseVoice 流式服务

- **双模**：`useSpeech.ts` 改造为 `mode: 'webspeech' | 'stt'`。Web Speech 走浏览器原生；STT 模式走 `getUserMedia → MediaRecorder → POST /transcribe → SttProvider`（Whisper / SenseVoice），从而不再受限于 Chrome/Edge。`activeModeRef` 记录当前模式，`stop()` 据此拆除对应资源。
- **客户端 VAD**：用 Web Audio `AnalyserNode` 每 100ms 采 RMS，静音 1s（且已说满 2s）切片，最长 8s 兜底，替代固定定时分片，断句更自然。
- **realtime_server.py**：新增 FastAPI WebSocket 服务，16kHz PCM 流式喂 SenseVoiceSmall，作为自部署 ASR 路径（#9，端到端验证待办）。

### 框选标注精简：去虚线框，仅箭头 + 摘要；读取统一

- **去框**：`createAnnotationShapes` 不再画橙色虚线 geo 框，改为只画"向右箭头 + 摘要卡"。箭头起点改到选区**右上角** `(maxX, minY)` 水平向外延伸，摘要紧跟其后。密集白板下更清爽。
- **读取同源**：新增 `getRoomDocMap()`，让 `createAnnotationShapes`（量几何）与 `getSelectedContent`（取图文）都从同一份快照读取，消除两处不一致；顺手移除无用的 `makeGeoShape` 与 `TLGeoShape` 导入。

### 多模态编排规范化（模态顺序 + 视觉预算）

- 统一 **图片在前、文字在后**：`/annotate` 与本地 Vision 路径都调整为图片打头，OpenAI Vision 本就如此；`/annotate` 把指令移入 system 消息。
- **视觉分辨率按任务**：`/vision`（OCR）用 `image_url.detail = 'high'`，`/annotate`（概括）用 `'auto'`。
- **澄清**：模态顺序与 70~1120 token 预算分档是 **Gemma 模型卡**的规定；线上主力是 GPT-4o，OpenAI 没有 token 预算字段，等价物是 `detail`，因此本地 Gemma 的预算只能在部署/运行时配置（已在代码注释中说明，不伪造无效参数）。
- 在 vision / annotate 提示词中加入"只依据实际可见信息、不臆测"的约束。

### Windows 按窗口标题截图（会议软件友好）

- 新增「🖥️ 窗口」按钮 + 标题输入框（默认 `CloudMeeting`）。`captureWindow` POST 到 `/vision/capture-local-window`（后端在 Windows 时）或本地助手 `:9999`。
- 服务端内联 PowerShell：`EnumWindows` 按标题子串（不区分大小写）匹配第一个可见窗口 → `PrintWindow` 抓帧 → base64。另有独立 `win-capture-helper.ps1`（监听 9999）供"后端在 Linux、前端在 Windows"的场景。
- **踩坑串烧**：
  1. `Add-Type -TypeDefinition` 的 C# 块里 `using System.Drawing(.Imaging)` 让独立编译失败（无该程序集引用）。其实该 Win32 类根本没用到 Drawing 类型 → 删掉两行 `using` 即可（Bitmap/Graphics 在 PowerShell 侧、已 `Add-Type -AssemblyName System.Drawing`）。
  2. 内联脚本写在 JS 模板字符串里，PowerShell 的 `$var` 需写成 `\$`，但 `\$` 在 JS 里是"无用转义"被 oxlint 拦下；用 perl 负向断言只去掉 **非 `${`** 的反斜杠，保留 `\${w}_\${h}` 这类必须的转义。
  3. `Find-TargetWindow` 里 `EnumWindows` 的布尔返回值会混进函数输出 → 加 `[void]`。
  4. 高分屏尺寸错位 → 启用 per-monitor DPI 感知；窗口带不可见阴影边 → 用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取真实边界。

### 远程部署：集中化后端地址

- 新增 `config.ts`：`SERVER` 优先 `VITE_SERVER_URL`，否则回退到**当前页面 hostname + :5858**；`WS_SERVER` 由 `http→ws` 派生。`App.tsx` / 三个 hook 全部从 `config` 导入，去掉各自硬编码的 `localhost:5858`，从远程主机访问时自动指向同主机后端。

### 房间别名与删除

- `GET/POST /rooms/:roomId/alias`（别名存 `data/rooms/aliases.json`，重启可用）；`DELETE /rooms/:roomId` 关闭 room 并删除 `.db` 与转写记录。房间选择器支持就地改名 / 删除。

### 踩坑：重复 dev 进程导致"截图/上传静默失效"

- 现象：点截图/上传，控制台无报错、白板也没东西。
- 根因：环境里累积了 ~11 个 `yarn dev`（tsx watch + vite）僵尸进程抢占 5858/5760。每次保存触发一堆 watcher 竞争重启后端，导致已打开的浏览器 tab **WebSocket sync 连接被反复打断**；此时 `/vision` 仍返回 200，但断连的前端收不到 sync 更新 → 看起来"什么都没发生"。
- 处理：杀掉全部僵尸、只跑一个 `yarn dev`、硬刷新浏览器即恢复。经验：起 `yarn dev` 前先确认没有旧实例（`pkill -f "server/server.ts"; pkill -f "vite/bin/vite.js dev"`）。
