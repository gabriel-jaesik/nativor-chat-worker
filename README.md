# Nativor Chat Worker

실시간 채팅을 위한 Cloudflare Workers + Durable Objects 기반 WebSocket 서버입니다.

## 아키텍처

- **Workers + Durable Object**: "방 = DO 1:1" 실시간 허브 (브로드캐스트만 처리, 저장X)
- **백엔드**: 인증/권한/메시지 저장/푸시, 그리고 참가자 체크 API 제공

## 보안

- 입장 시 WS auth 메시지로 받은 토큰을 백엔드에 검증
- 서버→DO 브로드캐스트는 WEBHOOK_TOKEN으로 보호

## 프로토콜 (클라이언트 ↔ DO)

### WebSocket 접속
```
wss://$WS_ENDPOINT/rooms?room=$roomId
```

### 핸드셰이크 (반드시 순서대로)

**클라이언트가 연결 → 곧바로 아래 전송**
```json
{ "type": "auth", "token": "<JWT or session token>", "roomId": "<room-id>", "userId": "<optional>" }
```

**서버 응답**
```json
{ "type": "auth:ok" }              // 성공
// 또는
{ "type": "error", "code": "unauthorized", "message": "..." }  // 실패 후 close
```

**인증 타임아웃**: 10초 내 auth 미수신 시 서버가 연결 종료(코드 4401).

### 이후 이벤트 (예시)

**클라이언트 → 서버 (옵션)**

타이핑:
```json
{ "type": "typing", "isTyping": true }
```

핑:
```json
{ "type": "ping", "t": 1710000000 }
```

**서버 → 클라이언트**

새 메시지 알림(백엔드가 /broadcast 호출 시):
```json
{ "type": "message.created", "id": "m123", "conversationId": "room-1", "preview": "안녕하세요" }
```

타이핑 팬아웃:
```json
{ "type": "typing", "userId": "u1", "isTyping": true }
```

퐁:
```json
{ "type": "pong", "t": 1710000000 }
```

## 서버→DO 브로드캐스트 (백엔드에서 호출)

```http
POST https://$WS_ENDPOINT/api/broadcast
Authorization: Bearer $WEBHOOK_TOKEN
Content-Type: application/json

{
  "roomId": "room-1",
  "message": { "type": "message.created", "id": "m123", "preview": "..." },
  "excludeConnectionIds": ["conn-abc"]   // 선택
}
```

**응답**: `200 { "success": true }` (실패 시 4xx/5xx 반환)

## 환경 변수

- `BACKEND_ORIGIN`: 예) https://api.nativor.com
- `WEBHOOK_TOKEN`: 백엔드→DO 브로드캐스트 인증용 토큰
- `ASSETS`: 정적 에셋 바인딩
- `Chat`: DO 네임스페이스 바인딩

## 수용 기준 (AC)

- `wss://.../rooms/:roomId` 로 접속 후 10초 내 auth 없으면 4401로 종료
- auth 수신 시 `POST BACKEND_ORIGIN/api/v1/message-rooms/:roomId/participants/check` 호출, 200이면 `{type:'auth:ok'}`
- 인증 전에는 typing 등 모든 이벤트를 무시/거절
- `POST /api/broadcast` 는 `Authorization: Bearer WEBHOOK_TOKEN` 없으면 401
- 서버에 주기 타이머 없음(하이버네이션 친화). 핑/퐁은 클라이언트 주도
- 방=DO 1:1 (소켓으로 다른 roomId 이동 불가)

## 개발

### 설치
```bash
npm install
```

### 로컬 개발 서버 실행
```bash
npm run dev
```

### 배포
```bash
npm run deploy
```

## 클라이언트 예시

### 웹 (JavaScript)
```javascript
const roomId = "conv_abc";
const ws = new WebSocket(`wss://ws.nativor.com/rooms?room=${encodeURIComponent(roomId)}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "auth", token: myJwt, roomId: roomId, userId: myUserId }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "auth:ok") {
    console.log("joined");
  } else if (msg.type === "message.created") {
    // 배지/리스트 갱신
  } else if (msg.type === "typing") {
    // 타이핑 표시
  }
};

function sendTyping(isTyping) {
  ws.send(JSON.stringify({ type: "typing", isTyping }));
}
```

### Flutter
```dart
final ws = await WebSocket.connect('wss://ws.nativor.com/rooms?room=${Uri.encodeComponent(roomId)}');
ws.add(jsonEncode({ 'type': 'auth', 'token': jwt, 'roomId': roomId, 'userId': userId }));
ws.listen((data) {
  final msg = jsonDecode(data);
  // switch on msg['type']
});
```

## 운영/보안 메모

- **하이버네이션 친화**: 서버에서 setInterval 금지(클라이언트 핑/퐁만)
- **권한 검사**: 참가자 체크 API에서 200 아닌 경우 반드시 close(4401)
- **CORS**: REST 엔드포인트(/api/broadcast)는 서버간 호출이므로 CORS 엄격히 제한하거나, 내부 네트워크에서만 사용
- **로그**: 토큰/개인정보 로그 금지. 에러만 요약 기록
- **스케일**: 방이 커지면 그대로 수평 확장(방=DO). 초대형 방은 별도 샤딩/허브 패턴 고려

## 테스트

WebSocket 클라이언트를 사용하여 실시간 채팅 기능을 테스트할 수 있습니다.
