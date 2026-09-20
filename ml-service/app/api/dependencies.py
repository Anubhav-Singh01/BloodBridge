import hmac

from fastapi import Request

from app.utils.errors import AppError


def require_service_secret(request: Request) -> None:
    """Protects service-to-service endpoints. Fails closed: with no secret configured, every call is rejected."""
    expected = request.app.state.settings.service_secret
    if expected is None:
        raise AppError(503, "SERVICE_NOT_CONFIGURED", "The service is not configured.")

    supplied = request.headers.get("x-service-secret")
    # compare_digest avoids leaking the secret through response timing.
    if supplied is None or not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
        raise AppError(401, "UNAUTHENTICATED", "Missing or invalid service credentials.")
