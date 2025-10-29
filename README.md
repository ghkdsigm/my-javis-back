# my-javis-back


src/
├─ server.js                    # 기존 유지: Express 부트스트랩
├─ ws.js                        # 기존 유지: WebSocket 핸들러
│
├─ routes/                      # [신규] HTTP 엔드포인트
│  ├─ jarvis.route.js           # POST /jarvis/act  (자비스 명령 진입점)
│  ├─ tts.route.js              # POST /tts         (선택: 음성합성 프록시)
│  └─ health.route.js           # GET  /health
│
├─ middlewares/                 # [신규] 선택
│  ├─ sse.js                    # SSE 유틸(스트리밍 응답 필요 시)
│  └─ error.js                  # 에러 응답 표준화
│
├─ graph/                       # [신규] LangGraph 상태머신
│  └─ jarvis.js                 # classify → route → do_* → speak
│
├─ nlu/                         # [신규] 인텐트/슬롯 구조화
│  └─ structured.js             # Zod + StructuredOutputParser
│
├─ tools/                       # 기존 + 확장(자비스 액션 툴)
│  ├─ openweather.js            # 기존
│  ├─ router.js                 # 기존(도구 라우터)
│  └─ jarvisTools.js            # [신규] open_app, play_media, web_search, calendar_add, note_add, smart_home, tts_stream
│
├─ services/                    # [신규] 외부 연동 분리(필요한 것만)
│  ├─ tts.service.js            # 로컬/서버 TTS 호출
│  ├─ search.service.js         # 웹검색 어댑터(있으면)
│  ├─ calendar.service.js       # 구글 캘린더 등
│  └─ phoneAgent.ws.js          # RN 단말 제어 브리지(OPEN_APP 등)
│
├─ llm/                         # 기존 유지
│  ├─ llamacpp.js
│  └─ openaiCompat.js
│
├─ state/                       # 기존 유지
│  └─ memory.js
│
├─ utils/                       # 기존 유지
│  ├─ flatten.js
│  └─ summarize.js
│
└─ config/                      # [신규] 선택
   ├─ env.js                    # 환경변수 로더
   └─ cors.js                   # Tailscale IP/MagicDNS 허용 등