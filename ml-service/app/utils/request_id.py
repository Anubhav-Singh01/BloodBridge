import re
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response

# Same rule as the backend (API.md 1.2): reuse a client-supplied id only if it is a short, safe token,
# otherwise generate one. The id is for log correlation only and is never trusted for anything else.
SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def register_request_id(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        supplied = request.headers.get("x-request-id")
        request_id = supplied if supplied and SAFE_REQUEST_ID.fullmatch(supplied) else str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
