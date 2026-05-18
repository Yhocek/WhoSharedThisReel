"""
WhoSharedThisReel — Domain Enumerations

Python-side mirrors of the Postgres ENUM types.
"""

from enum import Enum


class RoomStatus(str, Enum):
    WAITING = "waiting"
    PLAYING = "playing"
    FINISHED = "finished"
    EXPIRED = "expired"


class PlayerType(str, Enum):
    ANONYMOUS = "anonymous"
    REGISTERED = "registered"


class GamePhase(str, Enum):
    STARTING = "starting"
    PLAYBACK = "playback"
    REVEAL = "reveal"
    FINISHED = "finished"
