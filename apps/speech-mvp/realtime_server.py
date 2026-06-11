import os
import re
import json
import base64
import tempfile
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from funasr import AutoModel
from webui import format_str_v3

# -------------------------------------------------------------
# 1. 初始化 FastAPI 与加载 SenseVoiceSmall 模型
# -------------------------------------------------------------
app = FastAPI(title="SenseVoice Real-Time Streaming ASR")

print(">>> [1/2] 正在加载 SenseVoice 音频识别大模型...")
device = "cuda:0" if torch.cuda.is_available() else "cpu"
print(f"    使用设备: {device}")

# 加载 SenseVoiceSmall 模型
sense_model = AutoModel(
    model="iic/SenseVoiceSmall",
    trust_remote_code=True,
    remote_code="./SenseVoice/model.py",  # 保持与项目一致
    device=device,
)
print(">>> [2/2] 模型加载完成！正在准备启动 Web 服务...")

# -------------------------------------------------------------
# 2. 网页端界面 HTML (含高级毛玻璃 UI + 实时 Canvas 声波)
# -------------------------------------------------------------
HTML_CONTENT = """
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SenseVoice 实时语音转写</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-gradient: radial-gradient(circle at 50% 50%, #1e1e30 0%, #0d0d15 100%);
            --glass-bg: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.08);
            --text-primary: #f3f4f6;
            --text-secondary: #9ca3af;
            --accent-primary: #818cf8; /* 靛蓝 */
            --accent-glow: rgba(129, 140, 248, 0.4);
            --recording-glow: rgba(239, 68, 68, 0.4);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', 'Noto Sans SC', sans-serif;
            background: var(--bg-gradient);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow-x: hidden;
            padding: 20px;
        }

        /* 毛玻璃大卡片 */
        .container {
            width: 100%;
            max-width: 900px;
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            backdrop-filter: blur(20px);
            border-radius: 28px;
            padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            display: flex;
            flex-direction: column;
            gap: 30px;
            position: relative;
        }

        /* 顶部标题与状态 */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            padding-bottom: 20px;
        }

        .title-area h1 {
            font-size: 28px;
            font-weight: 800;
            background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .title-area p {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            background: rgba(255, 255, 255, 0.05);
            padding: 6px 14px;
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #ef4444; /* 默认未连接 */
            transition: all 0.3s ease;
        }

        .status-dot.connected {
            background-color: #10b981;
            box-shadow: 0 0 10px #10b981;
        }

        .status-dot.recording {
            background-color: #ef4444;
            animation: pulse 1.2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.3); opacity: 0.4; }
            100% { transform: scale(1); opacity: 1; }
        }

        /* 核心展示区：左侧控制，右侧文本 */
        .main-panel {
            display: grid;
            grid-template-columns: 320px 1fr;
            gap: 30px;
        }

        @media (max-width: 768px) {
            .main-panel {
                grid-template-columns: 1fr;
            }
        }

        /* 控制面板 */
        .control-panel {
            display: flex;
            flex-direction: column;
            gap: 20px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.04);
            padding: 24px;
            border-radius: 20px;
        }

        .control-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        label {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        select, input[type="range"] {
            width: 100%;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--text-primary);
            padding: 10px 14px;
            border-radius: 10px;
            outline: none;
            font-family: inherit;
            font-size: 14px;
        }

        select option {
            background: #1e1e30;
            color: var(--text-primary);
        }

        .range-value {
            font-size: 12px;
            color: var(--accent-primary);
            text-align: right;
            margin-top: -4px;
        }

        /* 录音按钮与声波 */
        .action-area {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            margin-top: 10px;
        }

        .record-btn {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            border: none;
            background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
            cursor: pointer;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 8px 24px var(--accent-glow);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
        }

        .record-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 12px 30px var(--accent-glow);
        }

        .record-btn:active {
            transform: scale(0.95);
        }

        .record-btn.active {
            background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);
            box-shadow: 0 8px 24px var(--recording-glow);
        }

        .record-btn svg {
            width: 32px;
            height: 32px;
            fill: white;
            transition: all 0.3s;
        }

        /* 实时波形画布 */
        canvas {
            width: 100%;
            height: 60px;
            background: rgba(0, 0, 0, 0.15);
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.03);
        }

        /* 转写结果输出面板 */
        .output-panel {
            display: flex;
            flex-direction: column;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 20px;
            height: 420px;
            position: relative;
        }

        .transcript-log {
            flex: 1;
            padding: 24px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
            scroll-behavior: smooth;
        }

        /* 精美文本段落 */
        .msg-bubble {
            animation: slideIn 0.3s ease-out forwards;
            line-height: 1.6;
            font-size: 16px;
            padding: 12px 18px;
            background: rgba(255, 255, 255, 0.02);
            border-left: 3px solid var(--accent-primary);
            border-radius: 0 12px 12px 0;
        }

        .msg-time {
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 4px;
            font-family: monospace;
        }

        /* 正在输入中的临时文本 */
        .interim-area {
            padding: 16px 24px;
            background: rgba(255, 255, 255, 0.03);
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 0 0 20px 20px;
            font-style: italic;
            color: #a5b4fc;
            min-height: 56px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 15px;
        }

        .blink-cursor {
            display: inline-block;
            width: 2px;
            height: 16px;
            background-color: var(--accent-primary);
            animation: blink 1s step-end infinite;
        }

        @keyframes blink {
            from, to { background-color: transparent }
            50% { background-color: var(--accent-primary); }
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* 表情/事件标签美化 */
        .tag-emoji {
            display: inline-block;
            background: rgba(129, 140, 248, 0.15);
            border: 1px solid rgba(129, 140, 248, 0.3);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 14px;
            margin: 0 4px;
            vertical-align: middle;
        }

        /* 自定义滚动条 */
        ::-webkit-scrollbar {
            width: 6px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.2);
        }
    </style>
</head>
<body>

<div class="container">
    <!-- 顶部状态栏 -->
    <div class="header">
        <div class="title-area">
            <h1>SenseVoice 实时流式语音转写</h1>
            <p>基于首字延迟极低、全包围多维度感知的 SenseVoice-Small 打造</p>
        </div>
        <div class="status-badge">
            <span id="status-dot" class="status-dot"></span>
            <span id="status-text">未连接服务器</span>
        </div>
    </div>

    <!-- 核心板块 -->
    <div class="main-panel">
        <!-- 左侧控制台 -->
        <div class="control-panel">
            <div class="control-group">
                <label for="lang-select">语言选择</label>
                <select id="lang-select">
                    <option value="auto">智能识别 (Auto)</option>
                    <option value="zh">中文 (Chinese)</option>
                    <option value="en">英文 (English)</option>
                    <option value="yue">粤语 (Cantonese)</option>
                    <option value="ja">日语 (Japanese)</option>
                    <option value="ko">韩语 (Korean)</option>
                </select>
            </div>

            <div class="control-group">
                <label for="threshold-slider">VAD 灵敏度 (阈值)</label>
                <input type="range" id="threshold-slider" min="0.005" max="0.08" step="0.005" value="0.015">
                <div class="range-value" id="threshold-val">0.015 (推荐值)</div>
            </div>

            <div class="control-group">
                <label for="timeout-slider">断句静音时长限制</label>
                <input type="range" id="timeout-slider" min="0.4" max="2.0" step="0.1" value="0.8">
                <div class="range-value" id="timeout-val">0.8 秒</div>
            </div>

            <!-- 控制区域与 Canvas 示波器 -->
            <div class="action-area">
                <button id="record-btn" class="record-btn" disabled>
                    <!-- 麦克风图标 -->
                    <svg id="mic-icon" viewBox="0 0 24 24">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                    </svg>
                </button>
                <span id="prompt-tip" style="font-size:12px; color:var(--text-secondary)">正在连接中...</span>
                <canvas id="visualizer"></canvas>
            </div>
        </div>

        <!-- 右侧转写展示区 -->
        <div class="output-panel">
            <div class="transcript-log" id="transcript-log">
                <div class="msg-bubble" style="border-left-color: var(--text-secondary); color: var(--text-secondary);">
                    💡 点击左侧麦克风开始说话。当说话结束后停止发音 0.8s，系统会自动断句并输出完美排版的转写结果。
                </div>
            </div>
            <div class="interim-area">
                <span>⚡ 实时口音侦测：</span>
                <span id="interim-text">暂无输入</span>
                <span class="blink-cursor"></span>
            </div>
        </div>
    </div>
</div>

<script>
    // 页面节点
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const recordBtn = document.getElementById('record-btn');
    const promptTip = document.getElementById('prompt-tip');
    const transcriptLog = document.getElementById('transcript-log');
    const interimText = document.getElementById('interim-text');
    const langSelect = document.getElementById('lang-select');
    const thresholdSlider = document.getElementById('threshold-slider');
    const thresholdVal = document.getElementById('threshold-val');
    const timeoutSlider = document.getElementById('timeout-slider');
    const timeoutVal = document.getElementById('timeout-val');
    const canvas = document.getElementById('visualizer');
    const canvasCtx = canvas.getContext('2d');

    // 全局状态
    let ws = null;
    let audioContext = null;
    let processor = null;
    let micStream = null;
    let isRecording = false;
    let latestRms = 0.0;

    // 格式化文本中的表情和符号
    function parseTextToHtml(text) {
        if (!text) return "";
        // 对情绪或音效标识进行前端 badge 渲染
        const emojiPattern = /[😊😡😔😰🤢😮👏🎼😀😭🤧😷❓]/g;
        return text.replace(emojiPattern, (match) => {
            return `<span class="tag-emoji">${match}</span>`;
        });
    }

    // 初始化 WebSocket 连线
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            statusDot.className = 'status-dot connected';
            statusText.innerText = '已就绪 (WebSocket Connected)';
            recordBtn.disabled = false;
            promptTip.innerText = '点击开始实时转写';
            sendConfig();
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'rms') {
                latestRms = data.rms;
            } else if (data.type === 'interim') {
                interimText.innerText = data.text;
            } else if (data.type === 'final') {
                interimText.innerText = '等待说话...';
                appendFinalMessage(data.text);
            }
        };

        ws.onclose = () => {
            statusDot.className = 'status-dot';
            statusText.innerText = '已断开，正在尝试重连...';
            recordBtn.disabled = true;
            promptTip.innerText = '重连中...';
            isRecording = false;
            recordBtn.classList.remove('active');
            setTimeout(connectWebSocket, 3000);
        };
    }

    // 发送配置信息至后端
    function sendConfig() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'config',
                language: langSelect.value,
                threshold: parseFloat(thresholdSlider.value),
                silence_timeout: parseFloat(timeoutSlider.value)
            }));
        }
    }

    // 将识别结果追加到日志区域
    function appendFinalMessage(text) {
        if (!text.strip || text.trim().length === 0) return;
        
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
        
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        
        bubble.innerHTML = `
            <div class="msg-time">${timeStr}</div>
            <div class="msg-content">${parseTextToHtml(text)}</div>
        `;
        
        transcriptLog.appendChild(bubble);
        transcriptLog.scrollTop = transcriptLog.scrollHeight;
    }

    // 监听配置更新
    langSelect.addEventListener('change', sendConfig);
    thresholdSlider.addEventListener('input', (e) => {
        thresholdVal.innerText = `${e.target.value} ${e.target.value === '0.015' ? '(推荐值)' : ''}`;
        sendConfig();
    });
    timeoutSlider.addEventListener('input', (e) => {
        timeoutVal.innerText = `${e.target.value} 秒`;
        sendConfig();
    });

    // 启动/停止录音
    recordBtn.addEventListener('click', async () => {
        if (!isRecording) {
            await startRecording();
        } else {
            stopRecording();
        }
    });

    async function startRecording() {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = audioContext.createMediaStreamSource(micStream);
            
            // 采用标准 ScriptProcessorNode 提取音频帧并降采样为 16KHz
            processor = audioContext.createScriptProcessor(4096, 1, 1);
            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                if (!isRecording) return;
                const float32Data = e.inputBuffer.getChannelData(0);
                
                // 将浮点 [-1.0, 1.0] 的单声道 PCM 转换为 int16 (16位) 二进制缓冲
                const int16Buffer = new Int16Array(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    const sample = Math.max(-1.0, Math.min(1.0, float32Data[i]));
                    int16Buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                }
                
                // 压缩发送二进制流
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(int16Buffer.buffer);
                }
            };

            isRecording = true;
            recordBtn.classList.add('active');
            statusDot.className = 'status-dot connected recording';
            promptTip.innerText = '正在聆听，请对着麦克风说话...';
            interimText.innerText = '等待发音...';
        } catch (err) {
            console.error('麦克风授权失败:', err);
            alert('无法启用麦克风，请检查浏览器权限设置！');
        }
    }

    function stopRecording() {
        isRecording = false;
        recordBtn.classList.remove('active');
        statusDot.className = 'status-dot connected';
        promptTip.innerText = '点击开始实时转写';
        interimText.innerText = '已暂停输入';

        if (processor) {
            processor.disconnect();
            processor = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }
        latestRms = 0;
    }

    // 绘制示波器波形
    function drawVisualizer() {
        requestAnimationFrame(drawVisualizer);
        
        const width = canvas.width = canvas.clientWidth;
        const height = canvas.height = canvas.clientHeight;
        
        canvasCtx.clearRect(0, 0, width, height);
        
        // 绘制声波基线
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = 'rgba(129, 140, 248, 0.4)';
        canvasCtx.beginPath();
        
        const amplitude = isRecording ? Math.min(height * 2.5, latestRms * height * 15) : 0;
        const points = 80;
        const sliceWidth = width / points;
        
        canvasCtx.moveTo(0, height / 2);
        
        for (let i = 0; i <= points; i++) {
            const x = i * sliceWidth;
            // 简单的随机波动 + 正弦波包络，模拟实时动态声浪
            const phase = Date.now() * 0.01;
            const y = (height / 2) + Math.sin(i * 0.15 + phase) * amplitude * Math.sin(Math.PI * i / points);
            canvasCtx.lineTo(x, y);
        }
        
        canvasCtx.stroke();
    }

    // 初始化运行
    connectWebSocket();
    drawVisualizer();
</script>
</body>
</html>
"""

# -------------------------------------------------------------
# 3. REST 接口：供 tldraw speech-mvp 的 SenseVoiceSttProvider 调用
#    POST /api/v1/asr
#    Body: { "audio_in": "<base64>", "audio_format": "webm|ogg", "lang": "auto" }
#    Response: { "code": 0, "data": "<text>" }
# -------------------------------------------------------------
@app.post("/api/v1/asr")
async def http_asr(request: Request):
    body = await request.json()
    audio_b64: str = body.get("audio_in", "")
    audio_fmt: str = body.get("audio_format", "webm")   # webm 或 ogg
    lang: str = body.get("lang", "auto")

    audio_bytes = base64.b64decode(audio_b64)
    suffix = f".{audio_fmt}"   # FunASR 根据扩展名选解码器（需系统有 ffmpeg）

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        res = sense_model.generate(
            input=tmp_path,
            language=lang,
            use_itn=True,
            merge_vad=True,
        )
        text = ""
        if res and len(res) > 0 and "text" in res[0]:
            text = format_str_v3(res[0]["text"])
        return {"code": 0, "data": text}
    except Exception as e:
        print(f"[HTTP ASR Error] {e}")
        return {"code": 1, "data": "", "error": str(e)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


# -------------------------------------------------------------
# 4. 根路径展示网页
# -------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def get_webpage():
    return HTMLResponse(content=HTML_CONTENT)

# -------------------------------------------------------------
# 5. WebSocket 流式音频处理核心
# -------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(">>> 收到新的客户端 WebSocket 实时连线。")
    
    # 状态变量
    audio_buffer = []  # 保存浮点 16KHz 音频帧的列表
    silence_frames = 0
    speech_started = False
    
    # 初始化断句配置
    lang = "auto"
    threshold = 0.015
    silence_timeout_sec = 0.8
    
    # 单次转写的最长限制（防止用户一直说话导致内存溢出或响应卡死）
    MAX_SPEECH_DURATION_SECS = 20
    max_speech_samples = MAX_SPEECH_DURATION_SECS * 16000

    try:
        while True:
            # 接收客户端消息
            message = await websocket.receive()
            
            # 如果是文本格式：即为用户界面参数变更（语言、阈值、断句超时时间）
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "config":
                        lang = data.get("language", "auto")
                        threshold = float(data.get("threshold", 0.015))
                        silence_timeout_sec = float(data.get("silence_timeout", 0.8))
                except Exception as e:
                    print(f"[WebSocket Config Error] {e}")
            
            # 如果是二进制格式：即为 16kHz 16-bit Mono PCM 录音包 (4096 采样，约 256ms)
            elif "bytes" in message:
                binary_data = message["bytes"]
                if len(binary_data) == 0:
                    continue
                
                # 转换 PCM16 -> Float32
                chunk_pcm16 = np.frombuffer(binary_data, dtype=np.int16)
                chunk_float32 = chunk_pcm16.astype(np.float32) / 32768.0
                
                # 动态计算当前帧的时长（秒）及所需的静音断句帧数
                chunk_duration = len(chunk_float32) / 16000.0
                silence_timeout_frames = max(1, round(silence_timeout_sec / chunk_duration)) if chunk_duration > 0 else 8
                
                # 计算这部分的能量 (RMS)
                rms = np.sqrt(np.mean(chunk_float32 ** 2)) if len(chunk_float32) > 0 else 0.0
                
                # 发送 RMS 回前端驱动声波示波器
                await websocket.send_json({"type": "rms", "rms": float(rms)})
                
                if rms > threshold:
                    # 语音开始
                    if not speech_started:
                        speech_started = True
                    silence_frames = 0
                    audio_buffer.append(chunk_float32)
                else:
                    if speech_started:
                        silence_frames += 1
                        audio_buffer.append(chunk_float32)
                        
                        # 达到了断句设定的静音时长
                        if silence_frames >= silence_timeout_frames:
                            # 拼接所有切片并推理
                            full_audio = np.concatenate(audio_buffer)
                            
                            # 仅对足够时长的有效声音转写
                            if len(full_audio) >= 16000 * 0.3:
                                try:
                                    res = sense_model.generate(
                                        input=full_audio,
                                        language=lang,
                                        use_itn=True,
                                        merge_vad=True
                                    )
                                    if res and len(res) > 0 and "text" in res[0]:
                                        raw_text = res[0]["text"]
                                        clean_text = format_str_v3(raw_text)
                                        # 返回 finalized 消息
                                        await websocket.send_json({"type": "final", "text": clean_text})
                                except Exception as e:
                                    print(f"[Inference Error] {e}")
                            
                            # 状态重置
                            audio_buffer = []
                            speech_started = False
                            silence_frames = 0
                        else:
                            # 处于说话中间的短停顿：提供 interim 实时流式候选词预览
                            # 累积超过 8000 个采样点 (约0.5s) 时才触发中间临时识别，每过 2 个静音块执行一次，减少冗余计算
                            if len(audio_buffer) > 0 and sum(len(x) for x in audio_buffer) >= 8000 and (silence_frames % 2 == 0):
                                full_audio = np.concatenate(audio_buffer)
                                try:
                                    res = sense_model.generate(
                                        input=full_audio,
                                        language=lang,
                                        use_itn=True,
                                        merge_vad=True
                                    )
                                    if res and len(res) > 0 and "text" in res[0]:
                                        raw_text = res[0]["text"]
                                        clean_text = format_str_v3(raw_text)
                                        await websocket.send_json({"type": "interim", "text": clean_text})
                                except Exception as e:
                                    pass
                    else:
                        # 纯静音阶段：维持一个 200ms 的 pre-roll 缓存，避免人声开启时被切掉头音
                        audio_buffer.append(chunk_float32)
                        # 200ms 对应大约 2 个 chunk
                        if len(audio_buffer) > 2:
                            audio_buffer.pop(0)

                # 安全锁：如果说话时间过长，强行触发一轮识别，防止爆显存/爆内存
                total_samples = sum(len(x) for x in audio_buffer)
                if total_samples >= max_speech_samples:
                    full_audio = np.concatenate(audio_buffer)
                    try:
                        res = sense_model.generate(
                            input=full_audio,
                            language=lang,
                            use_itn=True,
                            merge_vad=True
                        )
                        if res and len(res) > 0 and "text" in res[0]:
                            raw_text = res[0]["text"]
                            clean_text = format_str_v3(raw_text)
                            await websocket.send_json({"type": "final", "text": clean_text})
                    except Exception as e:
                        print(f"[Force Inference Error] {e}")
                    
                    audio_buffer = []
                    speech_started = False
                    silence_frames = 0
                    
    except WebSocketDisconnect:
        print(">>> 客户端 WebSocket 连线正常断开。")
    except Exception as e:
        print(f"[WebSocket Loop Error] {e}")

# -------------------------------------------------------------
# 6. 主程序启动入口
# -------------------------------------------------------------
if __name__ == "__main__":
    # 绑定 0.0.0.0 支持远程网络和外部端口暴露
    uvicorn.run(app, host="0.0.0.0", port=50000)
