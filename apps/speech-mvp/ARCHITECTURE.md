# 实时语音协作白板平台 — 架构设计

## 系统定位

在 tldraw 白板上实时呈现语音内容、AI 分析结果和图片理解输出，支持多人在线协作。核心链路：**声音/图像 → AI 处理 → 白板形状 → 实时广播**。

---

## 完整会议记录与白板标注流程

端到端 5 步工作流，覆盖从内容采集到白板可视化标注的完整闭环：

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ★ 系统音频采集                                                 │
│     · 点击"🔊 系统音频"按钮 → getDisplayMedia({audio:true})   │
│     · 每 10 秒滚动分片录制（完整 WebM）                        │
│     → base64 WebM → POST /transcribe → SttProvider            │
│     → 🔊 文字 shape 插入白板                                   │
│     → 停止时若 ≥2 段自动触发 POST /annotate（虚线框标注）     │
│                                                                 │
│  ① 截屏采集                                                     │
│     · 按需截图：点击"截图"按钮 → getDisplayMedia()             │
│     · 文件上传：选择本地图片文件                               │
│     → base64 PNG/JPG → POST /vision { image, roomId, w, h,    │
│                                        viewport? }             │
│     → ImageFrame shape 插入白板（显示原图）                    │
│                                                                 │
│  ② 多模态图片理解                                               │
│     → VisionProvider 流式分析                                  │
│       · 图片描述（3-5句，中文）                                │
│       · OCR 文字提取（"---OCR---"分隔符后输出）               │
│       · 与白板已有语音文字的关联分析                           │
│     → AgentCard（紫色，size='m' scale=1）紧贴图片右侧          │
│     → 独立 OCR Card（灰色）位于 AgentCard 下方               │
│     · 布局：有 viewport 时图片占左 2/3，分析占右 1/3          │
│                                                                 │
│  ③ 语音全量转写存文件                                           │
│     · 每条 final speech → 追加 transcripts/{roomId}.jsonl      │
│     · 格式：{ ts, text, x, y }（含时间戳和白板落点）           │
│     · GET /transcript/:roomId → 下载完整 JSONL 文件            │
│     · 控制栏"⬇ 转写记录"按钮触发下载                          │
│                                                                 │
│  ④ 滑动窗口摘要                                                 │
│     · 触发条件：每积累 300 字（SUMMARY_CHAR_THRESHOLD）        │
│     · POST /speech 和 POST /transcribe 均触发计数              │
│     → ChatConfig → SummaryCard shape（橙色，宽 600px）         │
│     · 无 max_tokens（Ollama 兼容规则）                         │
│     · 单条 user message（无 system role，Ollama 兼容规则）     │
│                                                                 │
│  ⑤ 白板标注（虚线框 + 箭头）                                   │
│     · 用户在白板框选若干 shape（tldraw 原生多选）               │
│     · 点击控制栏"🗂 标注"按钮                                   │
│     → POST /annotate { roomId, shapeIds } (SSE)                │
│     → 服务端计算极限 Bounding Box（文本图形按行高动态算高）     │
│     → 创建 geo shape（dash:'dashed'，color:'orange'）完美包围  │
│     → 提取选区内的纯文本和 Base64 图片资产进行图文混传发送给 AI │
│     → 创建 320px 宽的 SummaryCard，流式输出纯文本总结（无MD符号）│
│     · 自动从虚线框右边缘中点画 arrow 指向 SummaryCard          │
│     · 系统音频停止时也会自动触发（≥2 个 SpeechCard）           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**数据流总图：**

```
截屏/上传图片 ──→ POST /vision ──────────→ ImageFrame + AgentCard（流式）✅
                                                    ↑ 上下文感知（现有白板文字）

系统音频 ──→ getDisplayMedia ──→ POST /transcribe ──→ 🔊 SpeechCard  ✅
                                          └─ 停止时(≥2段) → POST /annotate ✅

麦克风 ──→ Web Speech API ──→ POST /speech ──→ SpeechCard  ✅
                │                  └──→ transcripts/{roomId}.jsonl  ✅
                │         字数≥300 ↓
                └─────→ triggerWindowSummary → SummaryCard  ✅

用户输入 ──→ POST /agent ────────────────→ AgentCard（流式）  ✅

框选 shapes ──→ POST /annotate ──→ geo(dashed) + arrow + SummaryCard  ✅

              所有写入均通过 room.storage.transaction()
                              │
                              ▼
                      TLSocketRoom broadcast
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              浏览器 A             浏览器 B
            (实时更新)           (实时更新)
```

**API 端点汇总：**

| 端点                             | 方法       | 功能                                                             | 状态                    |
| -------------------------------- | ---------- | ---------------------------------------------------------------- | ----------------------- |
| `/connect/:roomId`               | WS         | tldraw 白板实时同步                                              | ✅ 已实现               |
| `/speech`                        | POST       | 麦克风转写结果 → SpeechCard                                      | ✅ 已实现               |
| `/transcribe`                    | POST       | 系统音频 base64 → SttProvider → 🔊 SpeechCard                    | ✅ 已实现               |
| `/agent`                         | POST (SSE) | 用户输入 → ChatProvider 流式 → AgentCard                         | ✅ 已实现               |
| `/vision`                        | POST (SSE) | 图片 base64 → VisionProvider 流式 → ImageFrame + AgentCard + OCR | ✅ 已实现               |
| `/annotate`                      | POST (SSE) | shapeIds → 提取图文 → ChatProvider 流式 → geo + arrow + Summary  | ✅ 已实现（流式多模态） |
| `/rooms/:roomId/summaries`       | GET        | 获取指定页面内的所有阶段性摘要列表                               | ✅ 已实现               |
| `/rooms/:roomId/minutes`         | POST (SSE) | 汇总阶段性摘要 → 生成完整会议纪要卡片 + 本地保存为 .md 文件      | ✅ 已实现               |
| `/transcript/:roomId`            | GET        | 下载 JSONL 全量转写文件                                          | ✅ 已实现               |
| `/rooms`                         | GET        | 列出所有房间（按最近活跃排序）                                   | ✅ 已实现               |
| `/rooms/:roomId/active-page`     | POST       | 更新客户端当前活跃页面                                           | ✅ 已实现               |
| `/rooms/:roomId/checkpoints`     | GET        | 列出历史快照                                                     | ✅ 已实现               |
| `/rooms/:roomId/checkpoints`     | POST       | 保存当前白板快照                                                 | ✅ 已实现               |
| `/rooms/:roomId/checkpoints/:id` | GET        | 获取指定快照内容                                                 | ✅ 已实现               |

---

## Provider 抽象层

三个功能模块均通过环境变量切换后端，支持商业 API 和本地自部署模型。

### STT Provider（`src/server/stt.ts`）

```
STT_PROVIDER=auto|openai|sensevoice  (默认: auto)

auto:
  有 OPENAI_API_KEY → OpenAI Whisper-1
  无               → SenseVoice（自部署 FunASR HTTP server）

openai:
  OPENAI_STT_MODEL = whisper-1（默认）

sensevoice:
  SENSEVOICE_URL = http://localhost:7861
  接口: POST {url}/api/v1/asr
  Body: { audio_in: "<base64>", audio_format: "webm|ogg", lang: "auto" }
  响应: { code: 0, data: "<text>" }
```

### Chat Provider（`src/server/chat.ts`）

用于 `/agent` 端点和滑动窗口摘要（`triggerWindowSummary`）。

```
CHAT_PROVIDER=auto|openai|local  (默认: auto)

auto:
  有 OPENAI_API_KEY → OpenAI gpt-4o-mini
  无               → 本地 Ollama

openai:
  OPENAI_CHAT_MODEL = gpt-4o-mini（默认）

local:
  LOCAL_CHAT_URL   = http://localhost:11434
  LOCAL_CHAT_MODEL = gemma4（默认）
  → new OpenAI({ baseURL: url/v1, apiKey: 'ollama' })
```

### Vision Provider（`src/server/vision.ts`）

```
VISION_PROVIDER=auto|openai|local  (默认: auto)

auto:
  有 OPENAI_API_KEY → OpenAI GPT-4o
  无               → 本地 Ollama

openai:
  OPENAI_VISION_MODEL = gpt-4o（默认）
  使用 buildOpenAIMessages()：system role + user message（仅图片）

local:
  LOCAL_VISION_URL   = http://localhost:11434
  LOCAL_VISION_MODEL = qwen2-vl:7b（默认）
  使用 buildLocalMessages()：单条 user message（指令文本 + 图片）
  → new OpenAI({ baseURL: url/v1, apiKey: 'ollama' })
```

### Ollama 兼容性规则

与 Ollama OpenAI 兼容接口协作时须遵守的三条规则（gemma / qwen 等模型均适用）：

| 规则                          | 原因                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| 不使用 `role: 'system'`       | 部分 Ollama 模型遇 system role 返回空内容（无报错）          |
| 流式请求不传 `max_tokens`     | Ollama 将其映射为 `num_predict`；部分版本导致流式 delta 全空 |
| 使用 OpenAI SDK，不用裸 fetch | 手动 SSE 解析与部分 Ollama 版本有兼容差异                    |

---

## 整体架构

```
┌───────────────────────────────────────────────────────────────────┐
│                          浏览器客户端                              │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │   语音采集层    │  │   白板展示层   │  │   图片输入层     │  │
│  │ Web Speech API  │  │ tldraw + useSync│  │ 截图/文件上传    │  │
│  │ getDisplayMedia │  │ (TLSyncClient) │  │ useScreenCapture │  │
│  │ useSpeech.ts    │  │                │  │                  │  │
│  │ useSystemAudio  │  │                │  │                  │  │
│  └────────┬────────┘  └───────┬────────┘  └────────┬─────────┘  │
└───────────┼───────────────────┼────────────────────┼────────────┘
            │ HTTP POST         │ WebSocket           │ HTTP POST
            ▼                   ▼                     ▼
┌───────────────────────────────────────────────────────────────────┐
│               Fastify 服务层（port 5858，bodyLimit: 20MB）         │
│                                                                   │
│  POST /speech     POST /transcribe    POST /vision (SSE)          │
│  POST /agent (SSE)  POST /annotate    GET /transcript             │
│  GET /rooms  POST /rooms/:id/active-page                          │
│  GET/POST /rooms/:id/checkpoints  WS /connect/:roomId             │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │  ChatProvider   │  │  白板同步模块  │  │  VisionProvider  │  │
│  │  (chat.ts)      │  │  (rooms.ts)    │  │  (vision.ts)     │  │
│  │ OpenAI/Ollama   │  │ TLSocketRoom   │  │ GPT-4o/Ollama    │  │
│  ├─────────────────┤  │ NodeSQLite     │  ├──────────────────┤  │
│  │  SttProvider    │  │ shape工厂函数  │  │  transcript.ts   │  │
│  │  (stt.ts)       │  │               │  │  JSONL 文件存储  │  │
│  │ Whisper/SenseV  │  └───────────────┘  └──────────────────┘  │
│  └─────────────────┘                                             │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      持久化层                              │  │
│  │   NodeSqliteSyncWrapper（data/rooms/{roomId}.db）          │  │
│  │   speech_mvp_checkpoints 表（手动快照）                    │  │
│  │   transcripts/{roomId}.jsonl（全量转写）                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 模块详细设计

### 1. 语音处理模块

**采集链路：**

```
麦克风 → Web Speech API（浏览器原生，Chrome/Edge）
  ├─ interim result → POST /speech { isFinal:false } → 半透明占位 shape（0.45 opacity）
  └─ final result   → POST /speech { isFinal:true }  → 最终 shape（opacity 1）

系统音频 → getDisplayMedia({audio:true})（useSystemAudio.ts）
  ├─ 每 10 秒滚动分片，生成完整 WebM
  └─ final → POST /transcribe → SttProvider → 🔊 SpeechCard
```

**语音 shape 排版（speechPosition）：**

- X：用 `clickX` 做左列对齐锚点，存入 `roomXOffsets`
- Y：从 `roomYOffsets` 自动堆叠（步进 50px）
  - 若 `clickY > currentY`：跳到点击位置（允许用户在白板下方重新锚定）
  - 不允许向上跳（防止覆盖已有内容）
- 图片/Agent shape 用 130px 步进（`nextPosition`），语音用 50px（`speechPosition`）

**转写存储（transcript.ts）：**

```
每条 final speech → appendFileSync('transcripts/{roomId}.jsonl')
格式（每行一条）：
  { "ts": 1718000000000, "text": "...", "x": 40, "y": 340 }

GET /transcript/:roomId → Content-Type: application/x-ndjson
                        → Content-Disposition: attachment; filename="transcript-{roomId}.jsonl"
```

**滑动窗口摘要（triggerWindowSummary）：**

```
触发条件：roomCharCount ≥ SUMMARY_CHAR_THRESHOLD（300 字）
  → 重置计数器
  → ChatConfig.client.chat.completions.create({
        model, stream: true,
        messages: [{ role: 'user', content: '请将以下...' }]
        // 无 max_tokens（Ollama 兼容）
    })
  → 流式写入 SummaryCard（橙色，w=600）
```

---

### 2. 白板展示模块

**Shape 类型体系：**

| Shape           | 创建函数                                | 样式                          | 用途           |
| --------------- | --------------------------------------- | ----------------------------- | -------------- |
| SpeechCard      | `writeSpeechToRoom`                     | black, size=m                 | 语音转写结果   |
| AgentCard       | `createAgentShape` / `updateAgentShape` | black, size=m                 | Agent 流式输出 |
| SummaryCard     | `createSummaryCard`                     | orange, size=m, w=600         | 滑动窗口摘要   |
| ImageFrame      | `createImageShapeInRoom`                | TLImageShape + TLImageAsset   | 截图/上传图片  |
| VisionCard      | `createImageShapeInRoom`                | violet, size=m, scale=1       | 视觉分析描述   |
| OCR Card        | `createOcrShape`                        | grey, size=s, scale=0.5       | OCR 提取文字   |
| AnnotationFrame | `createAnnotationShapes`                | geo rectangle, dashed, orange | 虚线标注框     |
| AnnotationArrow | `createAnnotationShapes`                | arrow, orange                 | 指向摘要的箭头 |

**多页面支持：**

- 服务端维护 `roomActivePageId` Map，客户端切页时通过 `POST /rooms/:roomId/active-page` 通知
- 所有服务端写入的 shape 使用 `activePage(roomId)` 作为 `parentId`，落到用户当前页

**fractional indexing：** 所有 shape 使用 `getIndexAbove(last)` 维护 z-order，存于 `roomLastIndex`。

**上下文感知（getRoomContextText）：** 图片分析时读取房间内所有 text shape 纯文本，拼接后传入 VisionProvider 作为上下文。

---

### 3. 多模态图片理解模块

**客户端（useScreenCapture.ts）：**

```
captureScreen():
  1. getDisplayMedia({ video: { frameRate: 1 }, audio: false })
  2. Strategy 1: ImageCapture.grabFrame() → ImageBitmap → canvas → base64
     Strategy 2 (fallback): video element + readyState polling → canvas → base64
  3. POST /vision { image, mimeType, roomId, w, h, viewport? }
  4. drain SSE response（服务端实时更新 canvas）

uploadImage(file: File):
  1. FileReader.readAsDataURL() → Image.naturalWidth/Height
  2. POST /vision（同上）
```

**服务端布局逻辑（/vision 端点）：**

```
有 viewport 时：
  imgX  = getOrSetImageColumnX(roomId, vp.x + 10)   // 全会话固定左边缘
  imgW  = vp.w * 2/3 - 20                            // 图片占左 2/3
  summaryX = imgX + vp.w * 2/3 + 10                  // 分析卡起点
  summaryW = vp.w * 1/3 - 20                         // 分析卡占右 1/3

无 viewport 时：
  图片在点击位置，宽度 max 640px
  分析卡在图片右侧 +20px
```

**输出处理（summary / OCR 分层）：**

```
1. 流式接收 VisionProvider 输出
2. 按 "---OCR---" 分隔符拆分
3. agentShapeId → "📷 " + summary（VisionCard）
4. ocrShapeId   → "📝 " + ocrText（OCR Card，位于 VisionCard 下方）
   OCR Card 的 y 偏移基于 summary 行数动态计算（30px/行），避免重叠
```

**OpenAI vs 本地模型消息结构差异：**

```typescript
// OpenAI GPT-4o（buildOpenAIMessages）
[
  { role: 'system', content: VISION_INSTRUCTION },
  { role: 'user',   content: [{ type: 'image_url', ... }] }
]

// 本地 Ollama（buildLocalMessages）— 无 system role
[
  { role: 'user', content: [
      { type: 'text',      text: VISION_INSTRUCTION + contextText },
      { type: 'image_url', image_url: { url: 'data:...' } }
  ]}
]
```

---

### 4. 白板标注模块（虚线框 + 箭头）

```
POST /annotate { roomId, shapeIds: string[] } (SSE)

1. 读取所有 shapeId。若为 text 形状，通过富文本字符数与宽度动态估算高度以获取真实的外围极限；若为 image，提取其 Base64 图片资产。
2. 计算选中所有图形的最外围极值 Bounding Box (minX, minY, maxX, maxY)，加 20px padding。
3. 一次 transaction 写入三个 shape：
   ├─ geo rectangle（dashed, orange，完美包裹全部选中图形）
   ├─ arrow（从框右边缘中点出发，向右 60px）
   └─ text shape（SummaryCard，orange，宽度固定为 320px）
4. 解析选中的多模态内容（纯文本 + Base64 图片地址），拼装发送至大模型进行总结。
5. 提示词严禁输出 Markdown 字符，只通过换行分段。大模型流式（SSE）更新 SummaryCard 上的总结文本。
```

tldraw shape 参数：

```ts
// 虚线框
{ type: 'geo', props: { geo: 'rectangle', dash: 'dashed', color: 'orange',
                         fill: 'none', w: boundingW + 40, h: boundingH + 40 } }

// 箭头（shape.x = startX, shape.y = startY；start/end 相对自身原点）
{ type: 'arrow', props: { color: 'orange', arrowheadEnd: 'arrow',
                           start: { x: 0, y: 0 }, end: { x: 60, y: 0 } } }
```

---

### 5. 持久化模块

**白板状态（NodeSqliteSyncWrapper）：**

```
存储位置：data/rooms/{roomId}.db（better-sqlite3）
NodeSqliteSyncWrapper 处理 tldraw 协同数据序列化/反序列化

10 秒无连接 → 自动关闭 room 并清理内存状态（数据保留在 .db 文件）

快照 API：
  POST /rooms/:roomId/checkpoints       → 保存当前快照到 speech_mvp_checkpoints 表
  GET  /rooms/:roomId/checkpoints       → 列出所有快照（id, createdAt）
  GET  /rooms/:roomId/checkpoints/:id   → 返回快照完整 JSON
  客户端 editor.loadSnapshot()          → 恢复白板到指定快照
```

**转写记录（transcript.ts）：**

```
存储位置：transcripts/{roomId}.jsonl（append-only）
格式：{ ts: number, text: string, x: number, y: number }
```

---

### 6. 多房间支持

```
URL 参数 ?room=xxx → 指定房间，默认 speech-room

GET /rooms
  → 读取 data/rooms/ 目录，按最近修改时间排序
  → [{ roomId, lastModified }]

客户端房间选择器（下拉面板）：
  ├─ 列出所有历史房间，当前房间高亮
  └─ 切换房间时更新 URL 参数，重新建立 WebSocket 连接
```

---

### 7. 多用户协作

**现状：** 多窗口通过 tldraw sync 实时同步，tldraw 内置 presence（光标位置广播）。

**待开发：**

```
用户身份
  ├─ 加入房间时设置名字 + 选择颜色
  └─ 归因：每条 SpeechCard / AgentCard 记录 sessionId + 名字

权限（可选）
  ├─ 演讲者模式：只有授权用户可语音输入
  └─ 观察者模式：只读，不可操作白板
```

---

## 技术选型摘要

| 层        | 当前实现                                             | 扩展方向                    |
| --------- | ---------------------------------------------------- | --------------------------- |
| 语音转写  | Web Speech API + SttProvider（Whisper / SenseVoice） | 流式 Whisper WebSocket      |
| 对话/摘要 | ChatProvider（OpenAI gpt-4o-mini / Ollama）          | 多轮对话上下文              |
| 图片理解  | VisionProvider（GPT-4o / Ollama qwen-vl 等）         | R2/S3 替代 inline base64    |
| 白板同步  | TLSocketRoom + NodeSqliteSyncWrapper                 | Redis adapter（跨进程广播） |
| 服务框架  | Fastify + @fastify/websocket，bodyLimit 20MB         | 同，可加 Redis              |
| 部署      | 本地开发                                             | Cloudflare Workers / Fly.io |

---

## MVP 当前状态

**已完成：**

- [x] 语音转写（Web Speech API，interim → final）→ tldraw shape 实时同步
- [x] Agent 流式输出 → shape 逐 token 增长（SSE）
- [x] 多端实时协作（TLSocketRoom + WebSocket）
- [x] 点击画布定位落点 + 语音文字左对齐向下堆叠（50px 步进）
- [x] .tldr 文件导出（`serializeTldrawJson`）+ 导入（三格式自动识别）
- [x] ⑤ 框选标注：虚线框 + 箭头 + SummaryCard（已接入实际 AI 流式总结，支持图文混传且高度自适应）
- [x] 会议音频混音录制：利用 Web Audio API 将 getDisplayMedia 系统音频与 getUserMedia 麦克风音频进行混音
- [x] 页面摘要导出与会议纪要提炼：支持流式生成蓝色会议纪要卡片，同步自动在本地 minutes 目录保存为 md 文件
- [x] 全局衬线字体（Serif）支持：通过重写 tldraw UI CSS 变量与 body 字体设置，实现优雅的衬线字体样式，并保持控制栏为无衬线字体
- [x] 系统音频停止时自动触发标注（≥2 段时）
- [x] ① 屏幕截图采集（按需截图 + 文件上传）→ ImageFrame shape（`useScreenCapture.ts`）
- [x] ② 多模态图片理解（VisionProvider 流式）→ VisionCard + OCR Card
  - 支持 OpenAI GPT-4o / 本地 Ollama，通过 `VISION_PROVIDER` 切换
  - 有 viewport 时图片左 2/3、分析右 1/3；无 viewport 时图片 max 640px
- [x] ③ 全量转写存 JSONL（`transcripts/{roomId}.jsonl`）+ `GET /transcript/:roomId` 下载
- [x] ④ 滑动窗口摘要（300 字阈值 → ChatProvider → 橙色 SummaryCard，加入去重计数清空逻辑）
- [x] STT 抽象层（`stt.ts`）：OpenAI Whisper / SenseVoice，`STT_PROVIDER` 切换
- [x] Chat 抽象层（`chat.ts`）：OpenAI / Ollama，`CHAT_PROVIDER` 切换
- [x] Vision 抽象层（`vision.ts`）：OpenAI / Ollama，`VISION_PROVIDER` 切换
- [x] Ollama 兼容：无 system role、无 max_tokens、OpenAI SDK 统一调用
- [x] SQLite 持久化（`NodeSqliteSyncWrapper`）— 重启后数据不丢失
- [x] 快照历史 UI 面板：保存 / 查看 / 恢复历史快照
- [x] 多房间支持：`?room=xxx` URL 参数 + 控制栏房间选择器
- [x] 多页面支持：切页时通知服务端，shape 落到当前活跃页
- [x] 工具栏分组重组：语音 | 视觉 | Agent+标注 | 文件

**待完成：**

- [ ] SenseVoice 端到端验证
- [ ] 本地视觉模型效果评估（Qwen-VL / LLaVA）
- [ ] 用户身份与归因（演讲者颜色、光标 presence）
- [ ] 自动排版引擎（多列/时间线布局）
- [ ] 自动噪音校准调整（噪声自适应门限）
