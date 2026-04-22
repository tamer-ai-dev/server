export interface Envelope {
  v: 1;
  type: string;
  ts: number;
  id: string;
  payload: Record<string, unknown>;
}

export type ClientType = "cli" | "pwa";

export interface AuthRequest {
  api_key: string;
  client_type: ClientType;
}

export interface CliInstance {
  instance_id: string;
  name: string;
  agent_type: string;
  session_token: string;
}
