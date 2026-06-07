# WhoSharedThisReel — Architecture Decisions

This document records the foundational architecture and security decisions for the WhoSharedThisReel backend.

## Architecture Decision B3: No Direct Client-Supabase Connection
**Clients NEVER connect to Supabase directly.** 

All client traffic goes exclusively through the FastAPI backend, which alone holds the `service_role` key and manages database interactions.
- The Supabase `anon` key is backend-only and must **never** be shipped to any client.
- RLS policies on tables are intentionally permissive (e.g., `USING (true)`) because the database is not the security boundary.
- The security boundary is the FastAPI backend, which enforces authorization via short-lived room session tokens checked at the router level.

## Live Game Updates via FastAPI WebSocket
Because Architecture B3 prohibits clients from connecting to Supabase directly, Supabase Realtime is not used. Instead, the backend pushes live game updates itself using a native FastAPI WebSocket channel. 
- Clients connect to the WebSocket endpoint and authenticate using their room session token.
- Game events (`round_start`, `round_result`, `game_end`) are broadcasted via the backend's ConnectionManager.

## Single-Worker Constraint
Because the WebSocket connections, `ConnectionManager`, and `GameTaskManager` (which tracks round timers) store state in-memory, **the backend must run as a single worker process**. 

Running multiple uvicorn workers (e.g., via gunicorn) will silently break WebSocket broadcasts (since they only reach players connected to the same worker) and in-process round-task tracking.

*Future Scaling Item:* Introduce a shared backplane (e.g., Redis pub/sub) for WebSockets and task tracking if multi-worker deployment is required.
