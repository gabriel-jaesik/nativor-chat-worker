export type ChatMessage = {
  id: string;
  content: string;
  user: string;
  role: "user" | "assistant";
};

export type Message =
  | { type: "auth"; token: string; userId?: string; roomId?: string }
  | { type: "auth:ok" }
  | { type: "typing"; isTyping: boolean; userId?: string; roomId?: string; timestamp?: number }
  | { type: "ping"; t?: number }
  | { type: "pong"; t?: number }
  | { type: "message.created"; id: string; conversationId: string; preview?: string }
  | { type: "error"; code: string; message: string }
  | { type: "info"; message: string };
