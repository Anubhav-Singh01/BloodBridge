from fastapi import APIRouter, Depends, Request, Response

from app.api.dependencies import require_service_secret
from app.schemas.model import ModelInfoResponse
from app.services.model_service import ModelService
from app.utils.errors import AppError

router = APIRouter()


@router.get("/model", response_model=ModelInfoResponse, dependencies=[Depends(require_service_secret)])
def get_model(request: Request, response: Response) -> ModelInfoResponse:
    service: ModelService = request.app.state.model_service

    if service.state == "not_configured":
        raise AppError(503, "MODEL_NOT_CONFIGURED", "No model version is configured.")
    if service.artifact is None:
        raise AppError(503, "MODEL_UNAVAILABLE", "The configured model could not be loaded.")

    # Returns exactly what was validated from metadata.json, field for field. Nothing is calculated,
    # inferred, defaulted or filled in here: a missing field already made the artifact invalid
    # (see app/models/loader.py), and empty metrics are returned as {}.
    metadata = service.artifact.metadata
    response.headers["Cache-Control"] = "no-store"
    return ModelInfoResponse(
        modelVersion=metadata.model_version,
        algorithm=metadata.algorithm,
        datasetVersion=metadata.dataset_version,
        featuresUsed=metadata.features_used,
        metrics=metadata.metrics,
        trainedAt=metadata.trained_at,
    )
