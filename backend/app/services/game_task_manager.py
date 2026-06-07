"""
WhoSharedThisReel — Game Task Manager

Tracks active background tasks per room (like round timers and progressions)
to prevent them from being garbage-collected, and to allow cancellation
when a round ends early or a game finishes.

Also provides a safe wrapper for tasks to ensure exceptions are logged
rather than silently swallowed.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Set, Callable, Coroutine, Any

logger = logging.getLogger(__name__)

class GameTaskManager:
    def __init__(self):
        # Maps room_id -> set of active asyncio Tasks
        self.tasks: Dict[str, Set[asyncio.Task]] = {}

    def _safe_task(self, coro: Coroutine[Any, Any, Any], room_id: str, name: str) -> Coroutine[Any, Any, Any]:
        """Wrap a coroutine to catch and log exceptions."""
        async def wrapper():
            try:
                await coro
            except asyncio.CancelledError:
                logger.info(f"Task '{name}' for room {room_id} was cancelled.")
                raise
            except Exception as e:
                logger.exception(f"Unhandled exception in task '{name}' for room {room_id}: {e}")
        return wrapper()

    def spawn(self, room_id: str, coro: Coroutine[Any, Any, Any], name: str = "unnamed_task") -> asyncio.Task:
        """
        Spawn a task tied to a room, keeping a reference to it.
        The task will automatically remove itself from tracking when done.
        """
        if room_id not in self.tasks:
            self.tasks[room_id] = set()
            
        safe_coro = self._safe_task(coro, room_id, name)
        task = asyncio.create_task(safe_coro, name=f"{room_id}_{name}")
        self.tasks[room_id].add(task)

        # Remove from set when done
        task.add_done_callback(lambda t: self._remove_task(room_id, t))
        return task

    def _remove_task(self, room_id: str, task: asyncio.Task):
        """Internal callback to remove a completed task."""
        if room_id in self.tasks:
            self.tasks[room_id].discard(task)
            if not self.tasks[room_id]:
                del self.tasks[room_id]

    def cancel_room_tasks(self, room_id: str):
        """Cancel all active tasks for a given room."""
        if room_id in self.tasks:
            tasks_to_cancel = list(self.tasks[room_id])
            for task in tasks_to_cancel:
                task.cancel()
            logger.info(f"Cancelled {len(tasks_to_cancel)} tasks for room {room_id}")

    def cancel_task(self, room_id: str, task_name_suffix: str):
        """Cancel a specific task by suffix for a given room."""
        if room_id in self.tasks:
            tasks_to_cancel = [
                t for t in self.tasks[room_id] 
                if t.get_name().endswith(f"_{task_name_suffix}")
            ]
            for task in tasks_to_cancel:
                task.cancel()
            if tasks_to_cancel:
                logger.info(f"Cancelled task {task_name_suffix} for room {room_id}")

# Global singleton task manager
task_manager = GameTaskManager()
