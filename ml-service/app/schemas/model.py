from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ModelMetadata(BaseModel):
    """Shape of models/<model_version>/metadata.json, written by your training pipeline (ML.md section 5).

    Every field is required and has no default. A missing field makes the artifact invalid: the service
    never fills in, calculates or infers metrics, features or anything else. Unknown extra fields in the
    file are ignored and are never returned.
    """

    # "model_" is a protected prefix in pydantic, and model_version is the field name ML.md uses.
    model_config = ConfigDict(protected_namespaces=(), extra="ignore")

    model_version: str = Field(min_length=1)
    algorithm: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    features_used: list[str]
    metrics: dict[str, Any]
    trained_at: datetime


class ModelInfoResponse(BaseModel):
    """Body of GET /model: the validated contents of metadata.json and nothing else.
    Field names are camelCase, like the ML.md examples."""

    modelVersion: str
    algorithm: str
    datasetVersion: str
    featuresUsed: list[str]
    metrics: dict[str, Any]
    trainedAt: datetime
