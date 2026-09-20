from dataclasses import dataclass
from typing import Literal

from app.models.loader import ModelArtifact, ModelLoadError, load_model_artifact
from app.utils.logger import log
from app.utils.settings import Settings

# not_configured: ML_MODEL_VERSION is empty.
# unavailable:    a version is configured but its artifact is missing or invalid (see the log for the reason).
# available:      the artifact was found and its metadata is valid. Phase 2 does not load the model file.
ModelState = Literal["not_configured", "unavailable", "available"]


@dataclass(frozen=True)
class ModelService:
    state: ModelState
    artifact: ModelArtifact | None = None

    @classmethod
    def start(cls, settings: Settings) -> "ModelService":
        if settings.model_version is None:
            log("info", "no model version configured (ML_MODEL_VERSION is empty)")
            return cls(state="not_configured")

        try:
            artifact = load_model_artifact(settings.models_dir, settings.model_version)
        except ModelLoadError as error:
            # The service keeps running so the backend can fall back. The reason goes to the log only.
            log(
                "error",
                "model artifact could not be loaded",
                modelVersion=settings.model_version,
                reason=error.reason,
                detail=error.detail,
            )
            return cls(state="unavailable")

        log("info", "model artifact validated (model file not loaded in Phase 2)", modelVersion=artifact.version)
        return cls(state="available", artifact=artifact)
