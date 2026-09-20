import json
import sys
import traceback
from datetime import datetime, timezone
from typing import Any


def log(level: str, message: str, **fields: Any) -> None:
    """One JSON line per event. Errors go to stderr. Never pass secrets or request bodies in `fields`."""
    line = json.dumps(
        {"level": level, "time": datetime.now(timezone.utc).isoformat(), "message": message, **fields},
        default=str,
    )
    print(line, file=sys.stderr if level == "error" else sys.stdout, flush=True)


def describe_error(exc: BaseException, include_traceback: bool = True) -> dict[str, Any]:
    """Turns an exception into a loggable dict, optionally with the full traceback."""
    info: dict[str, Any] = {"name": type(exc).__name__, "message": str(exc)}
    if include_traceback:
        info["traceback"] = "".join(traceback.format_exception(exc))
    return info
