from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.health import router as health_router
from app.api.model import router as model_router
from app.services.model_service import ModelService
from app.utils.errors import register_error_handlers
from app.utils.logger import log
from app.utils.request_id import register_request_id
from app.utils.settings import load_settings

# Validated once at startup. Invalid configuration exits with code 1 and never prints values.
settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.model_service = ModelService.start(settings)
    log("info", "ml-service started", modelState=app.state.model_service.state)
    yield


def create_app() -> FastAPI:
    # The interactive docs and the OpenAPI schema are disabled: this is an internal service.
    app = FastAPI(
        title="BloodBridge AI ML service",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings

    register_request_id(app)
    register_error_handlers(app)

    app.include_router(health_router)
    app.include_router(model_router)
    # POST /predict is not implemented in Phase 2.
    return app


app = create_app()
