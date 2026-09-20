"""Environment configuration, validated once at startup.

Only the variables below are read. Values are never printed, because a value may be a secret.
"""

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ML_SERVICE_DIR = Path(__file__).resolve().parents[2]

MODEL_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
MIN_SECRET_LENGTH = 16


@dataclass(frozen=True)
class Settings:
    service_secret: str | None  # the backend sends this in X-Service-Secret
    model_version: str | None  # which models/<model_version>/ artifact to use, if any
    models_dir: Path


def load_settings() -> Settings:
    # Loads ml-service/.env when present. Variables already set in the environment win.
    load_dotenv(ML_SERVICE_DIR / ".env", override=False)

    problems: list[str] = []

    service_secret = os.environ.get("ML_SERVICE_SECRET", "").strip() or None
    if service_secret is not None and len(service_secret) < MIN_SECRET_LENGTH:
        problems.append(f"ML_SERVICE_SECRET: must be at least {MIN_SECRET_LENGTH} characters")

    model_version = os.environ.get("ML_MODEL_VERSION", "").strip() or None
    if model_version is not None and not MODEL_VERSION_PATTERN.fullmatch(model_version):
        problems.append(
            "ML_MODEL_VERSION: must be 1 to 64 characters (letters, digits, '.', '_' or '-') "
            "and start with a letter or digit"
        )

    if problems:
        print("Invalid environment configuration (values are never printed):", file=sys.stderr)
        for problem in problems:
            print(f" - {problem}", file=sys.stderr)
        sys.exit(1)

    return Settings(service_secret=service_secret, model_version=model_version, models_dir=ML_SERVICE_DIR / "models")
