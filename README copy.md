# Jarvis Local Backend (Node.js)

모바일 RN 앱과 **SSE**로 통신하고, 로컬 LLM(올라마/LM Studio/vLLM/llama.cpp 등)에 **프록시**합니다.

## 빠른 시작
```bash
# 1) 의존성 설치
npm i

# 2) 환경파일
cp .env.example .env
# .env를 열어 LLM_MODE와 LLM_BASE_URL/LLM_MODEL을 원하는 런타임에 맞게 수정
# 예: Ollama OpenAI 호환 모드라면 BASE_URL은 http://127.0.0.1:11434/v1

# 3) 실행
npm run dev
# 또는
npm start
```

기본 포트는 `4000` 입니다. RN 앱의 `BACKEND_SSE_URL`을
```
http://<PC-주소>:4000/api/chat/stream
```
로 맞추세요. (Tailscale을 쓰면 `<PC-주소>`에 Tailscale FQDN을 넣으면 됩니다.)

## 지원 모드
- `LLM_MODE=openai`: OpenAI 호환 `/v1/chat/completions` 스트리밍
  - Ollama: `ollama serve --api` + OpenAI 호환 프록시 사용 시 가능, 또는 Ollama의 OpenAI compat 엔드포인트 사용
  - LM Studio: OpenAI 호환 서버
  - vLLM: OpenAI 호환 서버
- `LLM_MODE=llamacpp`: 구형 llama.cpp HTTP `/completion` 스트리밍
- `LLM_MODE=mock`: LLM 없이 서버만 테스트

## 엔드포인트
- `GET /api/health`
- `GET /api/chat/stream?sessionId=android&text=...`
  - SSE 이벤트 형식
    - 기본 메시지: `data: {"text":"..."}`
    - 툴 이벤트: `event: tool\n data: {"ok":true,"type":"...","payload":{...}}`

## 툴 샘플
입력에 "알림", "예약" 같은 키워드가 포함되면 툴 이벤트를 먼저 보냅니다. 실제 캘린더/알림 연동은 `src/tools/router.js` 를 수정하세요.

## Windows 서비스처럼 항상 켜두기(선택)
- PowerShell: `Start-Process powershell -ArgumentList 'npm run dev'`
- PM2 사용: `npm i -g pm2 && pm2 start npm --name jarvis-backend -- run dev`

