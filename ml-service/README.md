# BloodBridge AI: ML service

A separate FastAPI service that will rank donors who have already passed every hard filter in the backend (see [ML.md](../ML.md)). It never approves donors and never overrides eligibility.

> **Status: Phase 2 skeleton.** No model has been trained and no model is loaded for prediction. There is no `/predict` endpoint yet. No performance figures exist.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Always 200 while the process runs. |
| `GET /model` | `X-Service-Secret` | The validated contents of the configured model's `metadata.json`, and nothing else. 503 if no model is available. |

`/model` never calculates, infers or fills in anything. Every metadata field is required, so a missing field makes the artifact invalid (503) instead of being replaced by a default. If `metrics` in the file is empty, `/model` returns `{}`.

Errors use the same envelope as the backend: `{"success":false,"error":{"code","message","requestId"}}`. Send `X-Request-ID` to choose the id, and search the server log for it to find the full cause of any failure.

## Setup

**Python 3.14 is the currently verified environment.** Python 3.11 to 3.13 are intended targets but are not verified yet.

```bash
cd ml-service
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

## Environment

See `.env.example`. `ML_SERVICE_SECRET` must match the backend's value. `ML_MODEL_VERSION` selects `models/<model_version>/`, and empty means no model.

## Model artifacts

```
models/<model_version>/model.joblib
models/<model_version>/metadata.json
```
`metadata.json` holds `model_version`, `algorithm`, `dataset_version`, `features_used`, `metrics` and `trained_at`, and is produced by your training runs. Everything under `models/` except `.gitkeep` is git-ignored.

Phase 2 only validates the artifact and reads its metadata. It never opens `model.joblib`, because a `.joblib` file is a pickle and loading one runs code. Only load artifacts you trained yourself.

## Layout

`app/` service code (`api/`, `services/`, `schemas/`, `utils/`, and `models/` for loader code), `training/` placeholder scripts, `datasets/` (empty), `models/` (artifacts, git-ignored).
