"""
WhoSharedThisReel — WebSocket Connection Manager

Manages active WebSocket connections per room to broadcast game events.
Also handles client disconnections to automatically remove them from the game.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Any
from fastapi import WebSocket, WebSocketDisconnect

from supabase import Client as SupabaseClient
from app.services.room_service import remove_player

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # Maps room_id -> list of active (WebSocket, player_id) tuples
        self.active_connections: Dict[str, List[tuple[WebSocket, str]]] = {}

    async def connect(self, websocket: WebSocket, room_id: str, player_id: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append((websocket, player_id))
        logger.info("Player %s connected to WebSocket in room %s", player_id, room_id)

    async def disconnect(self, websocket: WebSocket, room_id: str, player_id: str, supabase: SupabaseClient):
        if room_id in self.active_connections:
            # Remove the connection tuple
            self.active_connections[room_id] = [
                conn for conn in self.active_connections[room_id] if conn[0] != websocket
            ]
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                
        logger.info("Player %s disconnected from WebSocket in room %s", player_id, room_id)
        
        # Trigger automatic removal and telemetry zeroing on disconnect
        try:
            await remove_player(room_id, player_id, supabase)
        except Exception as e:
            logger.error("Failed to cleanly remove player %s on disconnect: %s", player_id, e)

    async def kick_player(self, room_id: str, player_id: str):
        """Find the websocket for player_id in room_id and close it (code 4001)."""
        if room_id not in self.active_connections:
            return
        to_close = []
        for connection in self.active_connections[room_id]:
            ws, pid = connection
            if pid == player_id:
                to_close.append(connection)
                
        for connection in to_close:
            ws, pid = connection
            try:
                await ws.close(code=4001, reason="Kicked by host")
            except Exception:
                pass
            if room_id in self.active_connections and connection in self.active_connections[room_id]:
                self.active_connections[room_id].remove(connection)
        if room_id in self.active_connections and not self.active_connections[room_id]:
            del self.active_connections[room_id]

    async def broadcast_to_room(self, room_id: str, message: Dict[str, Any]):
        """Push a JSON message to all connected clients in a room."""
        if room_id not in self.active_connections:
            return
            
        disconnected = []
        for connection in self.active_connections[room_id]:
            ws, player_id = connection
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.warning("Error broadcasting to player %s in room %s: %s", player_id, room_id, e)
                disconnected.append(connection)
                
        # Clean up any connections that threw errors during broadcast
        for ws, player_id in disconnected:
            if room_id in self.active_connections and (ws, player_id) in self.active_connections[room_id]:
                self.active_connections[room_id].remove((ws, player_id))

# Global singleton connection manager
manager = ConnectionManager()
