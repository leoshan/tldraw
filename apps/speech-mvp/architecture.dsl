workspace "Speech MVP Collaborative Whiteboard" "Architecture model for the Speech MVP platform which integrates real-time tldraw collaboration with speech transcription, AI agent insights, screenshot multimodal analysis, and auto-generated meeting minutes." {

    !identifiers hierarchical

    model {
        collaborator = person "Collaborator" "A user participating in the whiteboard session who speaks, draws, uploads images, and asks questions to the AI Agent."
        
        openai = softwareSystem "OpenAI API" "Cloud-based LLM & STT provider, running Whisper, GPT-4o, and gpt-4o-mini models." "External SaaS"
        ollama = softwareSystem "Local Ollama Service" "Self-hosted local LLM engine running Gemma and Qwen2-VL models." "External Local Service"
        sensevoice = softwareSystem "Local SenseVoice Server" "Self-hosted FunASR ASR server for low-latency Speech-to-Text." "External Local Service"

        system = softwareSystem "Speech MVP Board Platform" "Enables real-time speech transcription, AI agent interaction, screen capture analysis, and collaborative whiteboard editing." {
            
            webApp = container "Web Browser Client" "Delivers the collaborative canvas user interface, audio capture inputs, and screenshot capture controls." "TypeScript, React, tldraw, CSS" {
                editorUI = component "Whiteboard Editor UI" "Handles user interactions, canvas rendering, rooms selector, checkpoints panel, and triggers AI annotation/minutes operations." "React, tldraw"
                microphoneHook = component "Microphone Capture Hook" "Records user's voice from the microphone using Web Speech API and post-transcribes final utterances." "React Hook (useSpeech.ts)"
                screenCaptureHook = component "Screen Capture Hook" "Captures active window/viewport or files, uploading base64 data to the server." "React Hook (useScreenCapture.ts)"
                systemAudioHook = component "System Audio Hook" "Captures system audio streams via getDisplayMedia, chunking WebM audio to the server." "React Hook (useSystemAudio.ts)"
                syncClient = component "tldraw Sync Client" "Maintains real-time canvas state sync with Backend Server using WebSocket connection." "tldraw Sync Client"
            }

            backendServer = container "Backend Server" "Provides HTTP APIs for speech/vision/agent endpoints and WebSocket rooms synchronization." "TypeScript, NodeJS, Fastify, WS" {
                routes = component "Fastify Route Handlers" "Exposes API endpoints for speech transcribing, agent SSE streaming, screenshot analysis, shape annotation, and room management." "Fastify Router"
                roomManager = component "Room Manager" "Manages active tldraw rooms (TLSocketRoom), processes shapes creation/update transactions, and maps users to correct room pages." "TypeScript (rooms.ts)"
                chatProvider = component "Chat Provider" "Interacts with OpenAI or local Ollama LLM models for generating agents responses, summaries, and meeting minutes." "TypeScript (chat.ts)"
                sttProvider = component "STT Provider" "Translates audio file payloads into text using OpenAI Whisper API or local SenseVoice servers." "TypeScript (stt.ts)"
                visionProvider = component "Vision Provider" "Performs multimodal vision analysis and OCR text extraction on uploaded images using GPT-4o or local Qwen-VL." "TypeScript (vision.ts)"
                transcriptLogger = component "Transcript Logger" "Appends final transcription details into persistent JSONL transcript files." "TypeScript (transcript.ts)"
            }

            db = container "SQLite Databases" "Stores room sync logs, transaction histories, and user checkpoints for persistent canvas state." "SQLite / better-sqlite3" {
                tags "Database"
            }

            fileStorage = container "Local File System" "Stores meeting minutes in Markdown files and full transcripts in JSONL files." "Local Disk Storage" {
                tags "FileStorage"
            }
        }

        // --- Core Interactions ---
        collaborator -> system.webApp "Views collaborative canvas and triggers capture actions on"
        collaborator -> system.webApp.editorUI "Interacts with the canvas editor, panels, and trigger buttons"
        collaborator -> system.webApp.microphoneHook "Speaks into"
        collaborator -> system.webApp.screenCaptureHook "Shares screen or uploads files to"
        collaborator -> system.webApp.systemAudioHook "Starts system sound capture on"

        // --- Client Internal Connections ---
        system.webApp.editorUI -> system.webApp.syncClient "Updates and reads state from"
        system.webApp.editorUI -> system.webApp.microphoneHook "Controls recording state"
        system.webApp.editorUI -> system.webApp.screenCaptureHook "Triggers screenshot/upload"
        system.webApp.editorUI -> system.webApp.systemAudioHook "Controls system audio stream"

        // --- Client to Server Connections ---
        system.webApp.syncClient -> system.backendServer.routes "Synchronizes canvas shapes and user presence with" "WebSocket (WS/JSON)"
        system.webApp.microphoneHook -> system.backendServer.routes "Sends voice transcripts to /speech" "HTTP POST"
        system.webApp.screenCaptureHook -> system.backendServer.routes "Sends screenshot/file base64 payload to /vision" "HTTP POST (SSE)"
        system.webApp.systemAudioHook -> system.backendServer.routes "Sends 10s audio chunk WebM to /transcribe" "HTTP POST"
        system.webApp.editorUI -> system.backendServer.routes "Requests /agent, /annotate, /rooms/*, and checkpoints APIs from" "HTTP POST"

        // --- Server Internal Connections ---
        system.backendServer.routes -> system.backendServer.roomManager "Modifies canvas shapes and handles transactions in"
        system.backendServer.routes -> system.backendServer.chatProvider "Requests summaries/minutes from"
        system.backendServer.routes -> system.backendServer.sttProvider "Requests audio transcription from"
        system.backendServer.routes -> system.backendServer.visionProvider "Requests screenshot analysis from"
        system.backendServer.routes -> system.backendServer.transcriptLogger "Logs speech events to"

        system.backendServer.roomManager -> system.db "Loads, updates, and serializes whiteboard states and checkpoints in" "better-sqlite3"
        system.backendServer.transcriptLogger -> system.fileStorage "Appends speech lines to transcripts/{roomId}.jsonl" "appendFile"
        system.backendServer.routes -> system.fileStorage "Saves final meeting minutes to minutes/{roomId}.md" "writeFile"

        // --- Server to External Connections ---
        system.backendServer.chatProvider -> openai "Requests chat/summary completions from" "HTTPS"
        system.backendServer.chatProvider -> ollama "Requests local chat/summary completions from" "HTTP"
        system.backendServer.sttProvider -> openai "Transcribes audio via whisper-1 on" "HTTPS"
        system.backendServer.sttProvider -> sensevoice "Transcribes audio via FunASR on" "HTTP"
        system.backendServer.visionProvider -> openai "Analyzes image via gpt-4o on" "HTTPS"
        system.backendServer.visionProvider -> ollama "Analyzes image via local qwen2-vl on" "HTTP"

        // --- Local Deployment ---
        dev = deploymentEnvironment "Local Development" {
            developerLaptop = deploymentNode "Developer's Workstation" "A typical developer laptop running macOS or Linux." "MacBook Pro or ThinkPad" {
                browserNode = deploymentNode "Web Browser" "Google Chrome or Microsoft Edge running tldraw canvas." "Chrome/Edge" {
                    containerInstance system.webApp
                }
                fastifyNode = deploymentNode "Fastify Server Process" "NodeJS runtime environment running on port 5858." "Node.js v20" {
                    containerInstance system.backendServer
                }
                sqliteNode = deploymentNode "SQLite Files" "Flat files in project data/ directory." "SQLite 3" {
                    containerInstance system.db
                }
                fileSystemNode = deploymentNode "Project Directories" "Local folders transcripts/ and minutes/." "Local OS File System" {
                    containerInstance system.fileStorage
                }
                localAiNode = deploymentNode "Local AI Services" "Optional locally hosted models and servers." "Ollama & SenseVoice" {
                    softwareSystemInstance ollama
                    softwareSystemInstance sensevoice
                }
            }
        }
    }

    views {
        systemLandscape "landscape" "High-level landscape of the Speech MVP platform showing external services." {
            include *
            autolayout lr
        }

        systemContext system "system-context" "Context diagram of the Speech MVP Board Platform." {
            include *
            autolayout lr
        }

        container system "containers" "Container architecture of the Speech MVP Board Platform." {
            include *
            autolayout lr
        }

        component system.webApp "client-components" "Component diagram of the Web Browser Client." {
            include *
            autolayout lr
        }

        component system.backendServer "server-components" "Component diagram of the Backend Server." {
            include *
            autolayout lr
        }

        dynamic system "vision-flow-containers" "End-to-end container collaboration for screenshot capture and multimodal analysis." {
            collaborator -> system.webApp "Captures screenshot or uploads image file"
            system.webApp -> system.backendServer "Sends image payload and viewport data to /vision"
            system.backendServer -> system.db "Creates image and agent placeholder shapes"
            system.backendServer -> openai "Sends base64 image and context for description and OCR"
            system.backendServer -> system.webApp "Streams text completion chunks via SSE"
            system.backendServer -> system.db "Creates secondary OCR text shape below summary"
            system.webApp -> system.backendServer "Syncs state changes and user presence via WebSocket"
            autolayout lr
        }

        dynamic system.backendServer "vision-flow-components" "Component coordination within the backend server during image analysis." {
            system.webApp -> system.backendServer.routes "Posts image payload to /vision"
            system.backendServer.routes -> system.backendServer.roomManager "Requests image and agent shape creation"
            system.backendServer.roomManager -> system.db "Writes new shape records to SQLite"
            system.backendServer.routes -> system.backendServer.visionProvider "Requests analysis with context text"
            system.backendServer.visionProvider -> openai "Invokes OpenAI GPT-4o API (or Ollama)"
            system.backendServer.routes -> system.webApp "Streams SSE delta tokens"
            system.backendServer.routes -> system.backendServer.roomManager "Updates agent shape text"
            system.backendServer.routes -> system.backendServer.roomManager "Creates OCR shape below summary"
            system.backendServer.roomManager -> system.db "Writes OCR text shape to SQLite"
            autolayout lr
        }

        deployment system "Local Development" "local-dev-deployment" "Local development and services deployment model." {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape person
                background #0f172a
                color #ffffff
            }

            element "Software System" {
                background #1e293b
                color #ffffff
            }

            element "Container" {
                background #2563eb
                color #ffffff
            }

            element "Component" {
                background #3b82f6
                color #ffffff
            }

            element "Database" {
                shape cylinder
                background #0d9488
                color #ffffff
            }

            element "FileStorage" {
                shape folder
                background #d97706
                color #ffffff
            }

            relationship "Relationship" {
                color #64748b
                dashed false
            }
        }
    }
}
