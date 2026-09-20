"""Central error handling. The only place that decides what an error response looks like."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.utils.logger import describe_error, log


class AppError(Exception):
    """An error the client may see. `code` and `message` are sent as-is, so keep them free of secrets and internals.
    `details` is optional and only for safe field-level information."""

    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


# Fixed wording for framework errors. The framework's own `detail` text is never sent to clients.
_HTTP_ERRORS = {
    401: ("UNAUTHENTICATED", "Missing or invalid service credentials."),
    403: ("FORBIDDEN", "Access denied."),
    404: ("NOT_FOUND", "Route not found."),
    405: ("METHOD_NOT_ALLOWED", "Method not allowed."),
}


def _respond(
    request: Request,
    status: int,
    code: str,
    message: str,
    *,
    details: Any = None,
    cause: BaseException | None = None,
) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)

    # Server-side only: everything needed to debug, tagged with the request id.
    log(
        "error" if status >= 500 else "warn",
        "request failed",
        requestId=request_id,
        method=request.method,
        path=request.url.path,
        status=status,
        code=code,
        details=details,
        error=describe_error(cause, include_traceback=status >= 500) if cause is not None else None,
    )

    # API.md 1.1 error envelope. Optional keys are left out when they have no value.
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    if request_id is not None:
        error["requestId"] = request_id

    response = JSONResponse({"success": False, "error": error}, status_code=status)
    if request_id is not None:
        # Set here too: the generic 500 handler runs outside the request-id middleware.
        response.headers["X-Request-ID"] = request_id
    return response


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return _respond(request, exc.status, exc.code, exc.message, details=exc.details, cause=exc)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code, message = _HTTP_ERRORS.get(exc.status_code, ("REQUEST_ERROR", "The request could not be processed."))
        return _respond(request, exc.status_code, code, message, cause=exc)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field path and message only. FastAPI's default response echoes the submitted values, which is avoided here.
        details = [{"path": ".".join(str(part) for part in err["loc"]), "message": err["msg"]} for err in exc.errors()]
        return _respond(request, 400, "VALIDATION_ERROR", "The request is invalid.", details=details)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return _respond(request, 500, "INTERNAL_ERROR", "An unexpected error occurred.", cause=exc)
