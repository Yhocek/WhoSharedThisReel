import axios from 'axios';
import { getToken } from './session';

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------
const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
});

// ---------------------------------------------------------------------------
// Attach Bearer token to every outgoing request
// ---------------------------------------------------------------------------
api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---------------------------------------------------------------------------
// WebSocket URL helper
// ---------------------------------------------------------------------------

/**
 * Derive the WebSocket URL for a room from the REST API URL.
 *
 * https://  → wss://
 * http://   → ws://
 *
 * Format: ws(s)://<host>/api/v1/rooms/{roomId}/ws?token=<jwt>
 */
export async function getWsUrl(roomId: string): Promise<string> {
  const wsBase = API_URL.replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');

  const token = (await getToken()) ?? '';
  return `${wsBase}/api/v1/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`;
}

export default api;
