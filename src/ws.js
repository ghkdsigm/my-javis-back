// src/ws.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import { WebSocketServer } from 'ws';
import url from 'node:url';

const sockets = new Map(); // sessionId -> Set<WebSocket>

export function attachWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);

    // 경로 끝의 중복 슬래시 제거 후 비교
    // 예: '/ws/chat/' -> '/ws/chat'
    const cleanPath = String(pathname || '').replace(/\/+$/, '');

    // '/ws/chat' 또는 '/ws/chat/'만 허용
    if (!cleanPath.endsWith('/ws/chat')) {
      // 매치 안 되면 즉시 종료하여 핸드셰이크가 지연되지 않도록 한다.
      try { socket.destroy(); } catch {}
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = String(query.sessionId || '');
      if (!sessionId) {
        try { ws.close(1008, 'sessionId required'); } catch {}
        return;
      }

      const set = sockets.get(sessionId) || new Set();
      set.add(ws);
      sockets.set(sessionId, set);

      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('close', () => {
        const s = sockets.get(sessionId);
        if (!s) return;
        s.delete(ws);
        if (s.size === 0) sockets.delete(sessionId);
      });
    });
  });

  // 주기적 ping → pong 응답 없으면 종료
  setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, 30000);
}

// WS로 {text, ...} 프레임 브로드캐스트
export function wsSend(sessionId, obj) {
  const set = sockets.get(sessionId);
  if (!set || set.size === 0) return false;
  const payload = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
  return true;
}