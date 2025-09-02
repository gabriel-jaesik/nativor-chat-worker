# Flutter WebSocket Chat 통합 가이드

## 🔗 **WebSocket 연결 설정**

### 1. **연결 URL**
```dart
// 로컬 개발 환경
final String _workerUrl = 'ws://localhost:8787/rooms/room-123/messages';

// 프로덕션 환경  
final String _workerUrl = 'wss://your-worker.your-subdomain.workers.dev/rooms/room-123/messages';
```

### 2. **WebSocket 연결 및 인증**
```dart
import 'dart:convert';
import 'dart:io';

class ChatService {
  WebSocket? _socket;
  final String _workerUrl;
  final String _backendUrl;
  bool _isConnected = false;
  Timer? _pingTimer;
  Timer? _reconnectTimer;

  ChatService({
    required String workerUrl,
    required String backendUrl,
  }) : _workerUrl = workerUrl, _backendUrl = backendUrl;

  Future<void> connect() async {
    try {
      _socket = await WebSocket.connect(_workerUrl);
      _isConnected = true;
      
      // 메시지 수신 리스너 설정
      _socket!.listen(
        (message) => _handleMessage(message),
        onError: (error) => _handleError(error),
        onDone: () => _handleDisconnect(),
      );
      
      // 연결 후 즉시 인증
      await _authenticate();
      
      // ping 타이머 시작
      _startPingTimer();
      
    } catch (e) {
      _scheduleReconnect();
    }
  }

  Future<void> _authenticate() async {
    if (_socket == null || !_isConnected) return;
    
    try {
      // 백엔드에서 토큰을 받아온다고 가정
      final token = await _getAuthToken(); // 백엔드에서 토큰 가져오기
      
      final authMessage = {
        'type': 'auth',
        'token': token,
        'userId': 'user-123', // 백엔드에서 반환된 userId로 대체될 수 있음
        'roomId': 'room-123'  // 🔥 roomId 추가!
      };
      
      _socket!.add(jsonEncode(authMessage));
      
    } catch (e) {
      // 인증 실패 처리
    }
  }

  void _handleMessage(dynamic message) {
    try {
      final data = jsonDecode(message);
      
      switch (data['type']) {
        case 'auth:ok':
          // 인증 성공 처리
          break;
          
        case 'ping':
          // 즉시 pong 응답 (30초 타이머 리셋됨)
          _sendPong(data['t']);
          break;
          
        case 'pong':
          // pong 수신 처리
          break;
          
        case 'message.created':
          // UI 업데이트 로직
          break;
          
        case 'typing':
          // 타이핑 상태 처리
          break;
          
        case 'error':
          // 에러 처리
          if (data['code'] === 'ping_timeout') {
            // ping 타임아웃 - 재연결 필요
            _handleDisconnect();
          }
          break;
          
        case 'info':
          // 정보 메시지 처리
          break;
          
        default:
          // 알 수 없는 메시지 타입 처리
      }
    } catch (e) {
      // 메시지 파싱 에러 처리
    }
  }

  void _sendPong(int? timestamp) {
    if (_socket == null || !_isConnected) return;
    
    final pongMessage = {
      'type': 'pong',
      't': timestamp ?? DateTime.now().millisecondsSinceEpoch
    };
    
    _socket!.add(jsonEncode(pongMessage));
  }

  void _startPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(Duration(seconds: 25), (timer) {
      // 25초마다 ping (서버 30초 타이머보다 짧게)
      if (_socket != null && _isConnected) {
        final pingMessage = {
          'type': 'ping',
          't': DateTime.now().millisecondsSinceEpoch
        };
        _socket!.add(jsonEncode(pingMessage));
      }
    });
  }

  void _handleError(error) {
    _isConnected = false;
    _scheduleReconnect();
  }

  void _handleDisconnect() {
    _isConnected = false;
    _pingTimer?.cancel();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(seconds: 5), () {
      if (!_isConnected) {
        connect();
      }
    });
  }

  Future<String> _getAuthToken() async {
    // 백엔드에서 토큰을 가져오는 로직
    // 예: HTTP 요청으로 토큰 받기
    return 'your-auth-token';
  }

  void dispose() {
    _pingTimer?.cancel();
    _reconnectTimer?.cancel();
    _socket?.close();
  }
}
```

## 🚀 **사용 예시**

```dart
void main() {
  final chatService = ChatService(
    workerUrl: 'ws://localhost:8787/rooms/room-123/messages',
    backendUrl: 'http://localhost:3000',
  );
  
  // 연결 시작
  chatService.connect();
}
```

## 📋 **메시지 형식**

### **인증 메시지 (필수)**
```json
{
  "type": "auth",
  "token": "your-auth-token",
  "userId": "user-123",
  "roomId": "room-123"
}
```

### **Ping/Pong**
```json
// Ping (25초마다 전송)
{
  "type": "ping",
  "t": 1640995200000
}

// Pong (서버에서 즉시 응답)
{
  "type": "pong", 
  "t": 1640995200000
}
```

**참고**: 25초마다 ping을 보내는 것은 hibernation을 고려한 최적화된 주기입니다. 10초마다 보내면 DO가 계속 활성 상태로 유지되어 비용이 증가할 수 있습니다.

### **타이핑 상태**
```json
{
  "type": "typing",
  "isTyping": true
}
```

## 🔧 **주요 변경사항**

1. **`auth` 메시지에 `roomId` 추가**: 이제 클라이언트가 명시적으로 방 ID를 지정할 수 있습니다.
2. **자동 재연결**: 연결이 끊어지면 5초 후 자동으로 재연결을 시도합니다.
3. **Ping/Pong**: 30초마다 ping을 보내 연결 상태를 확인합니다.
4. **Ping 타임아웃**: 인증 완료 후 30초 내에 ping이 오지 않으면 연결을 자동으로 끊습니다.

## 🎯 **장점**

- **명확한 방 지정**: URL과 auth 메시지 모두에서 roomId를 확인하여 더 안정적
- **자동 재연결**: 네트워크 문제 시 자동으로 복구
- **연결 상태 모니터링**: ping/pong으로 연결 상태 실시간 확인
- **비활성 연결 정리**: ping이 없는 연결을 자동으로 정리하여 리소스 절약
