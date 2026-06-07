import os

BASE = r"d:\WhoSharedThisReel"

REVIEWER_NOTES = """## Reviewer Notes

**Boot confirmed:** Yes. The app still imports cleanly (18 routes registered, including the new `/ws` endpoint) and both `test_phase2.py` and `test_phase3_engine.py` pass fully. 

**Round timer:** A round timer task is scheduled via `GameTaskManager` at the beginning of each round using `asyncio.sleep(settings.round_duration_ms)`. If it fires, it force-closes the round by executing an atomic conditional update (`answered=False`) to zero out scores for any pending players, then triggers `_resolve_round`. If all players answer early, `submit_answer` explicitly cancels the timer by name using the `task_manager` before triggering `_resolve_round`.

**Double-resolution guard:** I used an in-memory lock `_resolved_rounds = set()` inside `_resolve_round`. Since the backend runs as a single worker process, checking and adding `f"{room_id}_{round_no}"` to this local set guarantees that the round resolution logic will execute exactly once, even if "all answered" and "timer fired" perfectly race.

**Live run:** No. The backend has only been run against the local test suites. It has not been run end-to-end against a real Supabase instance with real WebSockets.

**Anything not done or uncertain:** 
- The single-worker constraint makes the in-memory `GameTaskManager` and double-resolution lock safe. If the app is later scaled to multiple workers, these will need to be replaced with a Redis-backed scheduler/lock as documented in `ARCHITECTURE.md`.
- No new heavy dependencies (like Redis/Celery) were introduced, strictly honoring the single-worker architecture requested.

"""

FILES = [
    ("backend/ARCHITECTURE.md", "markdown"),
    ("database/migrations/001_phase1_rooms.sql", "sql"),
    ("database/migrations/002_phase2_reels.sql", "sql"),
    ("database/migrations/003_phase3_game.sql", "sql"),
    ("database/migrations/004_ownership_and_heartbeat.sql", "sql"),
    ("backend/requirements.txt", "text"),
    ("backend/.env.example", "text"),
    ("backend/app/main.py", "python"),
    ("backend/app/config.py", "python"),
    ("backend/app/dependencies.py", "python"),
    ("backend/app/models/enums.py", "python"),
    ("backend/app/schemas/reel.py", "python"),
    ("backend/app/schemas/game.py", "python"),
    ("backend/app/schemas/room.py", "python"),
    ("backend/app/services/token_service.py", "python"),
    ("backend/app/services/media_parser.py", "python"),
    ("backend/app/services/reel_service.py", "python"),
    ("backend/app/services/game_engine.py", "python"),
    ("backend/app/services/game_service.py", "python"),
    ("backend/app/services/room_service.py", "python"),
    ("backend/app/services/websocket_manager.py", "python"),
    ("backend/app/services/game_task_manager.py", "python"),
    ("backend/app/routers/health.py", "python"),
    ("backend/app/routers/reels.py", "python"),
    ("backend/app/routers/rooms.py", "python"),
    ("backend/app/routers/game.py", "python"),
    ("backend/test_phase2.py", "python"),
    ("backend/test_phase3_engine.py", "python"),
]

parts = [REVIEWER_NOTES]

for rel_path, lang in FILES:
    parts.append(f"## {rel_path}\n\n")
    abs_path = os.path.join(BASE, rel_path.replace("/", os.sep))
    if not os.path.exists(abs_path):
        parts.append("*** FILE NOT FOUND ***\n\n")
        continue
    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    # Security: redact real secrets in .env.example
    if rel_path == "backend/.env.example":
        lines = []
        for line in content.split("\n"):
            stripped = line.strip()
            if "=" in stripped and not stripped.startswith("#"):
                key, _, val = line.partition("=")
                if val.strip().startswith("eyJ") and "..." not in val:
                    lines.append(f"{key}=<REDACTED_PLACEHOLDER>")
                    continue
            lines.append(line)
        content = "\n".join(lines)
        
    parts.append(f"```{lang}\n{content}\n```\n\n")

output_path = os.path.join(BASE, "backend_codebase_report.md")
with open(output_path, "w", encoding="utf-8") as f:
    f.write("".join(parts))

print(f"Done. {len(FILES)} files processed. Output: {output_path}")
print(f"Output size: {os.path.getsize(output_path)} bytes")
