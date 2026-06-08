# 实时语音协作白板平台 — 架构设计

## 系统定位

在 tldraw 白板上实时呈现语音内容、AI 分析结果和图片理解输出，支持多人在线协作。核心链路：**声音/图像 → AI 处理 → 白板形状 → 实时广播**。

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
  ├─ 拖拽/粘贴到白板
  ├─ 文件选择器上传
  └─ 摄像头截图

                    ▼
      图片上传 → POST /vision { image, roomId, x, y }

                    ▼
      服务端流程
        ├─ 写入 ImageFrame shape（显示原图）
        ├─ 调用 GPT-4o Vision 分析
        │    ├─ 图片描述（中文）
        │    ├─ OCR 文字提取
        │    ├─ 场景/物体/情绪标签
        │    └─ 与当前白板内容的关联分析
        └─ 将分析结果写入 AgentCard（紧贴 ImageFrame 右侧）
```

**关键点：**

- 图片存储：base64 inline（MVP） → 对象存储 URL（生产）
- 流式输出：分析结果逐 token 更新 AgentCard（与 Agent 流相同机制）
- 上下文感知：将当前白板已有文字作为 system prompt 上下文传给 GPT-4o

---

### 4. 持久化模块

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

### 5. 多用户协作模块

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

| 层       | 当前实现                     | 扩展方向                    |
| -------- | ---------------------------- | --------------------------- |
| 语音转写 | Web Speech API               | OpenAI Whisper WebSocket    |
| 文字输出 | GPT-4o-mini stream           | GPT-4o（含视觉）            |
| 白板同步 | TLSocketRoom + InMemory      | + NodeSqliteSyncWrapper     |
| 图片存储 | base64 inline                | S3 / R2 对象存储            |
| 服务框架 | Fastify + @fastify/websocket | 同，可加 Redis adapter      |
| 部署     | 本地开发                     | Cloudflare Workers / Fly.io |

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

- [x] 语音转写（Web Speech API）→ tldraw shape 实时同步
- [x] Agent 流式输出 → shape 逐 token 增长
- [x] 多端实时协作（TLSocketRoom + WebSocket）
- [x] 点击画布定位落点
- [x] .tldr 文件导出
- [ ] Whisper 流式转写
- [ ] 语音内容摘要
- [ ] 多模态图片理解
- [ ] 持久化与历史回放
- [ ] 用户身份与归因
- [ ] 自动排版引擎
