from fastapi import APIRouter, Response

from app.schemas.health import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def get_health(response: Response) -> HealthResponse:
    # Liveness only. It stays 200 whether or not a model is available.
    response.headers["Cache-Control"] = "no-store"
    return HealthResponse(status="ok")
