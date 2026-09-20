"""Finds and validates a model artifact on disk.

Layout (ML.md section 5):
    models/<model_version>/model.joblib
    models/<model_version>/metadata.json

Phase 2 only VALIDATES the artifact: it checks that model.joblib exists and reads and validates
metadata.json. It never opens model.joblib, because a .joblib file is a pickle and loading one runs
code stored inside it. Real loading arrives with /predict (Phase 11) and must only ever be used on
artifacts you trained yourself.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from app.schemas.model import ModelMetadata

MODEL_FILE = "model.joblib"
METADATA_FILE = "metadata.json"


class ModelLoadError(Exception):
    """The artifact is missing or invalid.

    `reason` is a short code. `detail` explains it. Both are for the server log only and are never sent to clients.
    """

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class ModelArtifact:
    version: str
    directory: Path
    metadata: ModelMetadata


def load_model_artifact(models_dir: Path, version: str) -> ModelArtifact:
    directory = models_dir / version
    # `version` is already restricted to safe characters in settings.py. This is a second guard.
    if not directory.resolve().is_relative_to(models_dir.resolve()):
        raise ModelLoadError("PATH_OUTSIDE_MODELS_DIR", "the version resolves outside the models directory")
    if not directory.is_dir():
        raise ModelLoadError("ARTIFACT_DIR_MISSING", f"models/{version}/ does not exist")
    if not (directory / MODEL_FILE).is_file():
        raise ModelLoadError("MODEL_FILE_MISSING", f"models/{version}/{MODEL_FILE} not found")

    metadata_path = directory / METADATA_FILE
    if not metadata_path.is_file():
        raise ModelLoadError("METADATA_MISSING", f"models/{version}/{METADATA_FILE} not found")

    try:
        raw = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ModelLoadError("METADATA_UNREADABLE", f"{METADATA_FILE} is not valid UTF-8 JSON ({type(exc).__name__})") from exc

    try:
        metadata = ModelMetadata.model_validate(raw)
    except ValidationError as exc:
        # Field names and messages only. The submitted values are left out.
        problems = "; ".join(f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}" for err in exc.errors())
        raise ModelLoadError("METADATA_INVALID", problems) from exc

    if metadata.model_version != version:
        raise ModelLoadError("VERSION_MISMATCH", "model_version in metadata.json does not match the folder name")

    return ModelArtifact(version=version, directory=directory, metadata=metadata)
