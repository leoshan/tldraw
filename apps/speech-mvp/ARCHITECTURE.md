# 实时语音协作白板平台 — 架构设计

## 系统定位

在 tldraw 白板上实时呈现语音内容、AI 分析结果和图片理解输出，支持多人在线协作。核心链路：**声音/图像 → AI 处理 → 白板形状 → 实时广播**。

---

## 完整会议记录与白板标注流程

端到端 5 步工作流，覆盖从内容采集到白板可视化标注的完整闭环：

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ★ 系统音频采集（已实现）                                       │
│     · 点击"🔊 系统音频"按钮 → getDisplayMedia({audio:true})   │
│     · 每 10 秒滚动分片录制（完整 WebM，Whisper 可解码）        │
│     → base64 WebM → POST /transcribe → Whisper-1              │
│     → 🔊 文字 shape 插入白板                                   │
│     → 停止时若 ≥2 段自动触发 POST /annotate（虚线框标注）     │
│                                                                 │
│  ① 截屏采集（待开发）                                          │
│     · 按需截图：点击"截图"按钮 → getDisplayMedia()             │
│     · 定时截图：每 N 分钟自动截帧（可配置，默认关闭）          │
│     · 手动粘贴：Ctrl+V 直接粘贴图片到白板                      │
│     → base64 PNG → POST /vision { image, roomId, x, y }        │
│     → ImageFrame shape 插入白板（显示原图）                    │
│                                                                 │
│  ② 多模态图片理解                                               │
│     → GPT-4o Vision 流式分析（与 /agent 相同 SSE 机制）        │
│       · 图片描述（中文）                                        │
│       · OCR 文字提取                                            │
│       · 与白板已有语音文字的关联分析                           │
│     → AgentCard shape 紧贴 ImageFrame 右侧，逐 token 增长      │
│                                                                 │
│  ③ 语音全量转写存文件                                           │
│     · 每条 final speech → 追加 transcripts/{roomId}.jsonl      │
│     · 格式：{ ts, text, x, y }（含时间戳和白板落点）           │
│     · GET /transcript/:roomId → 下载完整 JSONL 文件            │
│     · 控制栏"⬇ 转写记录"按钮触发下载                          │
│                                                                 │
│  ④ 滑动窗口摘要                                                 │
│     · 触发条件：每积累 300 字（字数阈值，比时间阈值更稳定）    │
│     · writeSpeechToRoom() 内部维护 roomWordCount 计数器        │
│     · 超阈值后调用 POST /summarize { roomId, window }          │
│     → GPT-4o-mini → SummaryCard shape（右侧固定列 x=800）      │
│     · 摘要卡片有醒目边框色（orange），与普通文字卡片区分       │
│                                                                 │
│  ⑤ 白板标注（虚线框 + 箭头）【已实现，摘要待接 GPT】           │
│     · 用户在白板框选若干 shape（tldraw 原生多选）               │
│     · 点击控制栏"🗂 标注摘要"按钮                              │
│     → POST /annotate { roomId, shapeIds }                      │
│     → 服务端计算选中 shape bounding box                        │
│     → 创建 geo shape（dash:'dashed'，color:'orange'）包围选区  │
│     → 创建 arrow shape 从虚线框右边缘指向新 SummaryCard        │
│     → SummaryCard（stub 文字，后续接 GPT-4o-mini 实际摘要）    │
│     · 系统音频停止时自动触发（≥2 个 shape）                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**数据流总图（含新增流程）：**

```
截屏/粘贴图片 ──→ POST /vision ──────────→ ImageFrame + AgentCard（流式）[待开发]
                                                    ↑ 上下文感知
系统音频 ──→ getDisplayMedia ──→ POST /transcribe ──→ 🔊 SpeechCard  ✅
                                          └─ 停止时(≥2段) → POST /annotate ✅

麦克风 ──→ Web Speech API ──→ POST /speech ──→ SpeechCard  ✅
                │                  └──→ transcripts/{roomId}.jsonl（追加）[待开发]
                │         字数>300↓
                └─────→ POST /summarize ──→ SummaryCard  [待开发]

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

**新增 API 端点汇总：**

| 端点                  | 方法 | 功能                                                   | 状态                   |
| --------------------- | ---- | ------------------------------------------------------ | ---------------------- |
| `/transcribe`         | POST | 系统音频 base64 → Whisper-1 → 🔊 文字 shape            | ✅ 已实现              |
| `/annotate`           | POST | 选区 shapes → geo(dashed) + arrow + SummaryCard        | ✅ 已实现（stub 摘要） |
| `/vision`             | POST | 图片上传 → GPT-4o Vision 分析 → ImageFrame + AgentCard | 待开发                 |
| `/summarize`          | POST | 滑动窗口文字 → GPT-4o-mini 摘要 → SummaryCard          | 待开发                 |
| `/transcript/:roomId` | GET  | 下载 JSONL 全量转写文件                                | 待开发                 |

---

## 整体架构

```
┌───────────────────────────────────────────────────────────────────┐
│                          浏览器客户端                              │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │   语音采集层    │  │   白板展示层   │  │   图片输入层     │  │
│  │ Web Speech API  │  │ tldraw + useSync│  │ 拖拽/粘贴/摄像头 │  │
│  │ (→ Whisper WS)  │  │ (TLSyncClient) │  │                  │  │
│  └────────┬────────┘  └───────┬────────┘  └────────┬─────────┘  │
└───────────┼───────────────────┼────────────────────┼────────────┘
            │ HTTP/WS           │ WebSocket           │ HTTP
            ▼                   ▼                     ▼
┌───────────────────────────────────────────────────────────────────┐
│                       Node.js 服务层                               │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │  语音处理模块   │  │  白板同步模块  │  │  多模态理解模块  │  │
│  │                 │  │                │  │                  │  │
│  │ POST /speech    │  │ WS /connect/   │  │ POST /vision     │  │
│  │ WS  /whisper    │  │   :roomId      │  │                  │  │
│  │ POST /summarize │  │ TLSocketRoom   │  │ GPT-4o Vision    │  │
│  │                 │  │ Room 管理      │  │ OCR 提取         │  │
│  └────────┬────────┘  └───────┬────────┘  └────────┬─────────┘  │
│           └───────────────────┼────────────────────┘            │
│                               ▼                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      AI 服务层                             │  │
│  │   OpenAI Whisper · GPT-4o · GPT-4o-mini · Embedding       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                               │                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      持久化层                              │  │
│  │   SQLite (NodeSqliteSyncWrapper) · 对象存储(图片)          │  │
│  └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 模块详细设计

### 1. 语音处理模块

**现状**：Web Speech API → POST /speech → tldraw shape

**目标**：

```
麦克风音频流
  │
  ├─ VAD（静音检测）─→ 分句切块
  │
  ├─ 转写引擎
  │    ├─ 模式 A: Web Speech API（浏览器原生，低延迟，仅 Chrome）
  │    └─ 模式 B: OpenAI Whisper WebSocket 流（跨浏览器，更准确）
  │
  ├─ 实时展示：每个转写结果写入 tldraw shape（interim → final）
  │
  └─ 后处理管道
       ├─ 摘要生成: GPT-4o-mini 对积累内容滚动摘要
       ├─ 关键词提取: 实体、决策项、行动项
       └─ 结构化卡片: 将摘要写回白板（独立 Summary shape）
```

**关键接口：**

- `WS /whisper` — 接收 PCM 音频块，返回转写 delta
- `POST /summarize` — 对 roomId 已积累的所有文字做滚动摘要，写入白板
- `GET /transcript/:roomId` — 下载该房间完整转写记录（JSONL 格式）

**全量转写存储：**

```
每条 final speech → 追加写入 transcripts/{roomId}.jsonl
格式（每行一条）：
  { "ts": 1718000000000, "text": "...", "x": 40, "y": 340 }

触发摘要条件：
  roomWordCount（服务端维护）每超过 300 字 → 自动调用滑动窗口摘要
  → GPT-4o-mini 摘要最近 300 字 → SummaryCard（orange 色，x=800 固定列）
  → roomWordCount 重置
```

---

### 2. 白板展示模块

**现状**：文字 shape 堆叠，固定 x=40 起始，间距 130px

**目标：**

```
Shape 类型体系
  ├─ SpeechCard   — 语音转写卡片（含演讲者标识、时间戳）
  ├─ AgentCard    — Agent 流式输出卡片
  ├─ SummaryCard  — AI 摘要卡片（醒目边框）
  ├─ ImageFrame   — 上传的图片 + AI 描述
  └─ KeywordCloud — 关键词聚合形状
```

**排版引擎：**

- 单列模式（当前）：顺序堆叠
- 多列模式：按演讲者/主题分列
- 时间线模式：横向时间轴 + 纵向内容
- 点击定位（已实现）：用户手动指定落点

**演讲者归因：**

- 每个 session 分配颜色，shape 的 `props.color` 跟随演讲者
- 鼠标悬停显示演讲者名 + 时间戳

---

### 3. 多模态图片理解模块

```
图片输入来源
  ├─ 按需截图：getDisplayMedia() → canvas.captureStream() → 截帧
  ├─ 定时截图：setInterval + captureStream（每 N 分钟，默认关闭）
  ├─ 手动粘贴：Ctrl+V 粘贴到白板（tldraw 内置支持）
  ├─ 拖拽/文件选择器上传
  └─ （预留）摄像头截图

                    ▼
      图片 → base64 PNG → POST /vision { image, roomId, x, y }

                    ▼
      服务端流程
        ├─ 写入 ImageFrame shape（显示原图，w=640）
        ├─ 调用 GPT-4o Vision 流式分析
        │    ├─ 图片描述（中文）
        │    ├─ OCR 文字提取
        │    ├─ 场景/物体/内容标签
        │    └─ 与当前白板已有语音文字的关联分析
        └─ 将分析结果流式写入 AgentCard（紧贴 ImageFrame 右侧 +660px）
```

**关键点：**

- 图片存储：base64 inline（MVP） → R2/S3 对象存储 URL（生产，避免文档膨胀）
- 流式输出：复用 `/agent` 的 SSE 机制，分析结果逐 token 更新 AgentCard
- 上下文感知：将当前白板已有文字作为 system prompt 上下文传给 GPT-4o
- 白板衔接：ImageFrame 分析完成后，可进一步用⑤虚线框+箭头标注其关键区域

---

### 4. 白板标注模块（虚线框 + 箭头）

```
触发流程
  ├─ 用户在 tldraw 白板框选若干 shape（原生多选操作）
  ├─ 点击控制栏"标注摘要"按钮
  └─ 客户端读取 editor.getSelectedShapeIds() → 发送 POST /annotate

POST /annotate { roomId, shapeIds: string[] }
  ├─ 服务端读取选中 shape 的文字内容
  ├─ 调用 GPT-4o-mini 生成 1-3 句摘要
  ├─ 计算选中 shape 的 bounding box（union of all bounds）
  ├─ 创建 geo shape（类型: rectangle，dash: 'dashed'，color: 'orange'）
  │    包围 bounding box（留 20px padding）
  ├─ 创建 SummaryCard（文字 shape，放置于虚线框右侧 +700px）
  └─ 创建 arrow shape
       · 起点：虚线框右边缘中点
       · 终点：SummaryCard 左边缘中点
       · 样式：arrowheadEnd: 'arrow'，color: 'orange'
```

**tldraw shape 参数：**

```ts
// 虚线框
{ type: 'geo', props: { geo: 'rectangle', dash: 'dashed', color: 'orange',
                         w: boundingW + 40, h: boundingH + 40 } }

// 箭头
{ type: 'arrow', props: { color: 'orange', arrowheadEnd: 'arrow',
                           start: { x: frameRight, y: frameCenterY },
                           end:   { x: summaryLeft, y: summaryCenterY } } }
```

---

### 5. 持久化模块

**现状**：`InMemorySyncStorage`，服务重启数据丢失

**目标：**

```
存储层选型
  ├─ tldraw 官方: NodeSqliteSyncWrapper（packages/sync-core 已内置）
  │    └─ 每个 roomId 对应一个 SQLite 文件
  └─ Redis（可选，用于跨进程广播）

功能
  ├─ 房间持久化：重启后恢复画布状态
  ├─ 快照历史：定期保存时间点快照
  └─ 回放：按时间戳重放 shape 生长过程
```

---

### 6. 多用户协作模块

**现状**：多窗口通过 tldraw sync 实时同步，但无身份信息

**目标：**

```
用户身份
  ├─ 加入房间时设置名字 + 选择颜色
  ├─ Presence：光标位置实时广播（tldraw 已内置 presence 机制）
  └─ 归因：每条 SpeechCard / AgentCard 记录 sessionId + 名字

权限（可选）
  ├─ 演讲者模式：只有授权用户可语音输入
  └─ 观察者模式：只读，不可操作白板
```

---

## 技术选型摘要

| 层       | 当前实现                                                   | 扩展方向                    |
| -------- | ---------------------------------------------------------- | --------------------------- |
| 语音转写 | Web Speech API + OpenAI Whisper / SenseVoice（STT 抽象层） | 流式 Whisper WebSocket      |
| 文字输出 | GPT-4o-mini stream                                         | GPT-4o（含视觉）            |
| 白板同步 | TLSocketRoom + InMemory                                    | + NodeSqliteSyncWrapper     |
| 图片存储 | base64 inline                                              | S3 / R2 对象存储            |
| 服务框架 | Fastify + @fastify/websocket                               | 同，可加 Redis adapter      |
| 部署     | 本地开发                                                   | Cloudflare Workers / Fly.io |

---

## 数据流总图

```
麦克风 ──→ 转写引擎 ──→ POST /speech ──→ SpeechCard
                                  └──→ 积累文字 ──→ POST /summarize ──→ SummaryCard

图片   ──→ POST /vision ──→ ImageFrame + GPT-4o ──→ AgentCard

用户输入 ──→ POST /agent ──→ GPT-4o stream ──→ AgentCard

                所有写入均通过 room.storage.transaction()
                        │
                        ▼
                TLSocketRoom broadcast
                        │
                ┌───────┴───────┐
                ▼               ▼
          浏览器 A           浏览器 B
        (实时更新)          (实时更新)
```

---

## MVP 当前状态

**已完成：**

- [x] 语音转写（Web Speech API）→ tldraw shape 实时同步
- [x] Agent 流式输出 → shape 逐 token 增长
- [x] 多端实时协作（TLSocketRoom + WebSocket）
- [x] 点击画布定位落点
- [x] .tldr 文件导出
- [x] 系统音频采集 → 滚动分片 → 白板（`useSystemAudio.ts` + `POST /transcribe`）
- [x] ⑤ 框选标注：虚线框 + 箭头 + SummaryCard（stub 摘要，`POST /annotate`）
- [x] 系统音频停止时自动触发标注（≥2 段时）
- [x] ① 屏幕截图采集（按需截图 + 文件上传）→ ImageFrame shape
- [x] ② 多模态图片理解（GPT-4o Vision 或本地 Ollama 流式）→ AgentCard + OCR Card
  - 图片左 2/3 显示，分析结果右 1/3，size='s' scale=0.5 小字体
  - 支持 OpenAI / 本地 Ollama/vLLM，通过 `VISION_PROVIDER` 切换
- [x] ③ 全量转写存 JSONL 文件（`transcripts/{roomId}.jsonl`）
  - `GET /transcript/:roomId` 下载，客户端"⬇ 转写记录"按钮
- [x] ④ 滑动窗口摘要（300 字阈值 → GPT-4o-mini → 橙色 SummaryCard）
- [x] STT 抽象层 (`src/server/stt.ts`)：OpenAI Whisper / SenseVoice 双路径
  - `STT_PROVIDER=auto|openai|sensevoice` + `SENSEVOICE_URL` 切换

**待完成：**

- [ ] ⑤ `/annotate` 中接入实际 GPT-4o-mini 摘要（当前为 stub 文字）
- [ ] SenseVoice 端到端验证（见 Issue #9）
- [ ] 自部署多模态视觉模型效果评估（Qwen-VL / LLaVA，见 Issue #9）
- [ ] 持久化与历史回放（NodeSqliteSyncWrapper）
- [ ] 用户身份与归因
- [ ] 自动排版引擎（多列/时间线布局）
