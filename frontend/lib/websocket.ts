import { getWsUrl } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type EventCallback = (data: unknown) => void;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface ServerMessage {
  event: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket Manager
// ---------------------------------------------------------------------------
class WebSocketManager {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventCallback>>();
  private _state: ConnectionState = 'idle';
  public lastRoundStart: any = null;

  /** Current connection state (read-only). */
  get state(): ConnectionState {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  /**
   * Open a WebSocket connection to the given room.
   *
   * Resolves when the connection is established; rejects on failure.
   *
   * **POLICY**: No auto-reconnect. If the socket drops while the game is
   * in progress the player is considered disconnected.  The UI should show
   * a "Disconnected" state and NOT attempt to reconnect automatically.
   */
  async connect(roomId: string): Promise<void> {
    // Tear down any previous connection
    this.disconnect();

    this.setState('connecting');
    const url = await getWsUrl(roomId);

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);

      socket.onopen = () => {
        console.log('[WS] Connected to', url);
        this.setState('connected');
        resolve();
      };

      socket.onmessage = (event: WebSocketMessageEvent) => {
        this.handleMessage(event.data);
      };

      socket.onerror = (err) => {
        console.error('[WS] Error', err);
        // If we never opened, reject the promise
        if (this._state === 'connecting') {
          this.setState('disconnected');
          reject(new Error('WebSocket connection failed'));
        }
      };

      socket.onclose = (event: WebSocketCloseEvent) => {
        console.log('[WS] Closed', event.code, event.reason);
        this.setState('disconnected');
        // Dispatch a synthetic "ws_close" event so the UI can react
        this.dispatch('ws_close', { code: event.code, reason: event.reason });
      };

      this.ws = socket;
    });
  }

  // -----------------------------------------------------------------------
  // Event registration
  // -----------------------------------------------------------------------

  /**
   * Register a listener for a specific event name
   * (e.g. "round_start", "round_result", "game_end").
   */
  onEvent(eventName: string, callback: EventCallback): void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(callback);
  }

  /**
   * Remove ALL listeners for a given event name.
   */
  removeEvent(eventName: string): void {
    this.listeners.delete(eventName);
  }

  // -----------------------------------------------------------------------
  // Disconnect
  // -----------------------------------------------------------------------

  /**
   * Cleanly close the WebSocket. No auto-reconnect will happen.
   */
  disconnect(): void {
    if (this.ws) {
      // Detach handlers so the onclose handler doesn't fire during teardown
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, 'Client disconnected');
      }
      this.ws = null;
    }
    this.setState('idle');
  }

  // -----------------------------------------------------------------------
  // Send (optional utility)
  // -----------------------------------------------------------------------

  /**
   * Send a JSON payload over the open socket.
   * Throws if the socket is not connected.
   */
  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private setState(next: ConnectionState): void {
    if (next !== this._state) {
      console.log(`[WS] ${this._state} → ${next}`);
      this._state = next;
      // Dispatch a synthetic state-change event
      this.dispatch('ws_state', { state: next });
    }
  }

  private handleMessage(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== 'string') {
      console.warn('[WS] Non-string message received, ignoring');
      return;
    }

    try {
      const msg = JSON.parse(raw) as ServerMessage;
      if (!msg.event) {
        console.warn('[WS] Message missing "event" field:', raw);
        return;
      }
      
      if (msg.event === 'round_start') {
        this.lastRoundStart = msg;
      }
      
      this.dispatch(msg.event, msg);
    } catch {
      console.warn('[WS] Failed to parse message:', raw);
    }
  }

  private dispatch(eventName: string, data: unknown): void {
    const callbacks = this.listeners.get(eventName);
    if (!callbacks) return;
    for (const cb of callbacks) {
      try {
        cb(data);
      } catch (err) {
        console.error(`[WS] Error in listener for "${eventName}":`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------
const wsManager = new WebSocketManager();
export default wsManager;
