// index.ts
import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

type AuthedConn = Connection & { authed?: boolean; userId?: string };

interface Env {
  BACKEND_ORIGIN: string; // e.g. https://api.nativor.com
  WEBHOOK_TOKEN: string;  // backend -> DO broadcast auth
  ASSETS: any;            // static asset binding
  Chat: any;              // Durable Object namespace binding
}

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  private roomId!: string;
  private authTimers = new Map<string, number>(); // short-lived auth timeouts only
  private pingTimers = new Map<string, number>(); // ping timeout timers
  private lastMessage: unknown | null = null; // hibernation-friendly last message storage

  // No timers or intervals here to keep hibernation-friendly
  onStart() { }

  onConnect(conn: AuthedConn) {
    // room = DO 1:1
    const extractedRoomId = this.extractRoomId(conn);
    this.roomId = this.roomId ?? extractedRoomId ?? "default";

    // ask client to auth (optional UX)
    conn.send(JSON.stringify({ type: "info", message: "please auth" }));

    // enforce auth within 10s, then close (4401)
    const t = setTimeout(() => {
      if (!conn.authed) {
        conn.send(JSON.stringify({ type: "error", code: "unauthorized", message: "auth timeout" }));
        conn.close(4401, "auth required");
      }
      this.authTimers.delete(conn.id);
    }, 10_000) as unknown as number;
    this.authTimers.set(conn.id, t);
  }

  onClose(conn: AuthedConn) {
    const t = this.authTimers.get(conn.id);
    if (t) {
      // @ts-ignore - CF runtime supports clearTimeout
      clearTimeout(t);
      this.authTimers.delete(conn.id);
    }

    // ping 타이머도 정리
    const pingTimer = this.pingTimers.get(conn.id);
    if (pingTimer) {
      // @ts-ignore - CF runtime supports clearTimeout
      clearTimeout(pingTimer);
      this.pingTimers.delete(conn.id);
    }
  }

  async onMessage(conn: AuthedConn, raw: WSMessage) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); }
    catch { return this.sendError(conn, "bad_json", "malformed json"); }

    if (!msg?.type) return this.sendError(conn, "bad_payload", "missing type");

    // 1) authentication
    if (msg.type === "auth") {
      const token = msg.token as string | undefined;
      if (!token) return this.sendError(conn, "bad_payload", "token required");

      // roomId가 제공되면 사용, 없으면 기존 방식으로 추출
      const roomId = msg.roomId || this.roomId;
      if (!roomId) {
        this.sendError(conn, "bad_payload", "roomId required");
        return conn.close(4401, "roomId required");
      }

      // validate against backend
      const result = await this.checkParticipant(roomId, token);
      if (!result.success) {
        this.sendError(conn, "unauthorized", "not a participant");
        return conn.close(4401, "unauthorized");
      }

      // roomId 설정
      this.roomId = roomId;
      conn.authed = true;
      // 백엔드에서 반환된 userId 사용, 없으면 클라이언트에서 보낸 userId 사용
      conn.userId = result.userId || msg.userId;
      const t = this.authTimers.get(conn.id);
      if (t) {
        // @ts-ignore
        clearTimeout(t);
        this.authTimers.delete(conn.id);
      }

      // 인증 완료 후 30초 내에 ping이 오지 않으면 연결 종료
      const pingTimer = setTimeout(() => {
        if (!conn.authed) return; // 이미 연결이 끊어진 경우

        conn.send(JSON.stringify({
          type: "error",
          code: "ping_timeout",
          message: "ping timeout - connection will be closed"
        }));
        conn.close(1000, "ping timeout");
        this.pingTimers.delete(conn.id);
      }, 30_000) as unknown as number;

      this.pingTimers.set(conn.id, pingTimer);

      return conn.send(JSON.stringify({ type: "auth:ok" }));
    }

    // 2) reject all non-auth before authentication
    if (!conn.authed) {
      return this.sendError(conn, "unauthorized", "auth first");
    }

    // 3) post-auth events
    switch (msg.type) {
      case "ping":
        // ping 타이머 리셋
        const pingTimer = this.pingTimers.get(conn.id);
        if (pingTimer) {
          // @ts-ignore
          clearTimeout(pingTimer);
          this.pingTimers.delete(conn.id);
        }

        // 새로운 30초 타이머 설정
        const newPingTimer = setTimeout(() => {
          if (!conn.authed) return; // 이미 연결이 끊어진 경우

          conn.send(JSON.stringify({
            type: "error",
            code: "ping_timeout",
            message: "ping timeout - connection will be closed"
          }));
          conn.close(1000, "ping timeout");
          this.pingTimers.delete(conn.id);
        }, 30_000) as unknown as number;

        this.pingTimers.set(conn.id, newPingTimer);

        return conn.send(JSON.stringify({ type: "pong", t: msg.t ?? Date.now() }));

      case "typing": {
        const payload = {
          type: "typing",
          userId: conn.userId ?? "unknown",
          isTyping: !!msg.isTyping,
          roomId: this.roomId,
          timestamp: Date.now(),
          before: this.lastMessage // 이전 메시지 정보도 포함
        };
        // fan-out to others in the same DO (exclude sender)
        return this.broadcast(JSON.stringify(payload), [conn.id]);
      }

      default:
        return this.sendError(conn, "unknown_type", `unknown: ${msg.type}`);
    }
  }

  // Backend -> DO broadcast (protected)
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${this.env.WEBHOOK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = await request.json().catch(() => null) as {
        roomId?: string;
        message?: unknown;
        excludeConnectionIds?: string[];
      } | null;

      if (!body?.roomId || !body?.message) {
        return new Response(JSON.stringify({ success: false, error: "roomId and message required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      // ensure this DO handles the right room
      if (!this.roomId) this.roomId = body.roomId;
      if (body.roomId !== this.roomId) {
        return new Response(JSON.stringify({ success: false, error: "wrong room instance" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      // 브로드캐스트할 메시지에 이전 메시지 정보 추가
      const broadcastMessage = {
        ...body.message,
        before: this.lastMessage
      };

      // 마지막 메시지 저장 (hibernation 친화적)
      this.lastMessage = body.message;

      this.broadcast(JSON.stringify(broadcastMessage), body.excludeConnectionIds);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 마지막 메시지 조회 엔드포인트
    if (url.pathname === "/last-message" && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${this.env.WEBHOOK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      return new Response(JSON.stringify({
        success: true,
        lastMessage: this.lastMessage,
        roomId: this.roomId
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ---- helpers ----

  private extractRoomId(conn: Connection): string | null {
    try {
      if (conn.url) {
        const u = new URL(conn.url);
        const m = u.pathname.match(/^\/rooms\/([^/]+)$/); // path: /rooms/:roomId
        if (m) return m[1];
        return u.searchParams.get("room");
      }

      // PartyKit에서 헤더로 전달된 room 정보 사용
      // @ts-ignore
      const roomHeader = conn.requestHeaders?.get?.("X-PartyKit-Room");
      if (roomHeader) return roomHeader;

      // 원본 URL에서 room 정보 추출
      // @ts-ignore
      const originalUrl = conn.requestHeaders?.get?.("X-Original-URL");
      if (originalUrl) {
        const u = new URL(originalUrl);
        const m = u.pathname.match(/^\/rooms\/([^/]+)$/);
        if (m) return m[1];
      }

      // PartyKit 내장 room 정보 사용
      // @ts-ignore
      if (conn.room?.name) return conn.room.name;

    } catch (error) {
      // silent fail
    }

    return null;
  }

  private async checkParticipant(roomId: string, token: string): Promise<{ success: boolean; userId?: string }> {
    try {
      const res = await fetch(
        `${this.env.BACKEND_ORIGIN}/api/v1/message-rooms/${encodeURIComponent(roomId)}/participants/check`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        }
      );

      if (res.status === 200) {
        const data = await res.json().catch(() => ({})) as { userId?: string };
        return { success: true, userId: data.userId };
      }

      return { success: false };
    } catch {
      return { success: false };
    }
  }

  private sendError(conn: Connection, code: string, message: string) {
    conn.send(JSON.stringify({ type: "error", code, message }));
  }
}

// Edge routing
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // 1) WebSocket upgrade: /rooms/:roomId
    if (url.pathname.match(/^\/rooms\/[^/]+$/) && request.headers.get("Upgrade") === "websocket") {
      const roomId = url.pathname.split("/")[2];
      const id = env.Chat.idFromName(roomId);
      const stub = env.Chat.get(id);

      // forward to the DO with room headers
      const headers = new Headers(request.headers);
      headers.set("X-PartyKit-Room", roomId);
      headers.set("X-PartyKit-Party", "chat");
      headers.set("X-Original-URL", request.url); // 원본 URL도 전달

      const direct = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
      });

      const resp = await stub.fetch(direct);

      if (resp.status === 101) return resp; // WS upgraded
      return resp;
    }

    // 2) REST broadcast: /api/broadcast -> forward to the room DO
    if (url.pathname === "/api/broadcast" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { roomId?: string; message?: unknown; excludeConnectionIds?: string[] } | null;
      const roomId = body?.roomId;
      if (!roomId) {
        return new Response(JSON.stringify({ success: false, error: "roomId required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const id = env.Chat.idFromName(roomId);
      const stub = env.Chat.get(id);

      const res = await stub.fetch(new Request("http://internal/broadcast", {
        method: "POST",
        headers: {
          "Authorization": request.headers.get("authorization") || "",
          "Content-Type": "application/json",
          "X-PartyKit-Room": roomId,
          "X-PartyKit-Party": "chat",
        },
        body: JSON.stringify(body),
      }));

      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    // 3) 마지막 메시지 조회: /api/last-message/:roomId
    if (url.pathname.match(/^\/api\/last-message\/[^/]+$/) && request.method === "GET") {
      const roomId = url.pathname.split("/")[3];
      if (!roomId) {
        return new Response(JSON.stringify({ success: false, error: "roomId required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const id = env.Chat.idFromName(roomId);
      const stub = env.Chat.get(id);

      const res = await stub.fetch(new Request("http://internal/last-message", {
        method: "GET",
        headers: {
          "Authorization": request.headers.get("authorization") || "",
          "Content-Type": "application/json",
          "X-PartyKit-Room": roomId,
          "X-PartyKit-Party": "chat",
        },
      }));

      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    // 4) fallthrough: Party routing or static assets
    return (await routePartykitRequest(request, { ...env })) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
