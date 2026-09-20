# BloodBridge AI

BloodBridge AI is a full-stack blood donation and emergency blood management platform. It is designed to connect patients, blood donors, hospitals, blood banks and administrators, and to rank eligible donors for a blood request using a machine-learning model that the project owner will train.

> **Not a medical authority.** BloodBridge AI is a software platform. Blood compatibility, donor eligibility and every other medical decision belong to hospitals, blood banks and qualified medical professionals.

> **Status: early development.** This repository currently contains design documents and project scaffolding only. It is not production-ready, no business features are implemented, and no machine-learning model has been trained. No performance figures exist.

## Repository structure

```text
BloodBridge/
├── frontend/      React + Vite + TypeScript web app
├── backend/       Express + TypeScript modular API
├── ml-service/    Python FastAPI service for donor ranking
├── database/      Reserved for future database-related artifacts
├── docs/          Documentation index
├── ARCHITECTURE.md, DATABASE.md, API.md, ML.md    Phase 1 design documents
├── .gitignore
└── README.md
```

## Technology

- **Frontend:** React, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query, Clerk, Zod, React Hook Form, Axios
- **Backend:** Node.js, Express, TypeScript, Zod, Drizzle ORM, PostgreSQL on Neon, Clerk, Helmet, CORS
- **ML service:** Python (3.14 verified; 3.11 to 3.13 intended but not yet verified), FastAPI, Uvicorn, pandas, NumPy, scikit-learn, XGBoost

## Design documents (Phase 1)

The Phase 1 documents are the source of truth for the project.

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, matching pipeline, batch escalation, status models, security |
| [DATABASE.md](DATABASE.md) | Database design, request state machine, concurrency rules, privacy |
| [API.md](API.md) | API conventions, authorization model, endpoints |
| [ML.md](ML.md) | ML target, feature audit, service contract, training infrastructure |

## Current status

- **Phase 1 (design):** complete.
- **Phase 2 (scaffolding):** complete. Each service has a runnable skeleton and nothing more: the backend serves `/health` and `/ready`, the frontend shows a placeholder page, and the ML service serves `/health` and `/model`.
- **Next:** Phase 3 (database schema and migrations).

Not implemented yet: authentication flows, database schema and migrations, donor matching, blood requests, inventory, the request state machine, ML training and prediction, Google Maps integration, notifications, webhooks, cron jobs, admin workflows, and donor and facility verification.

### Known Phase 2 limitations

- **`GET /ready` (backend)** only checks that configuration loaded. The database readiness check described in API.md is not implemented yet. Phase 2 never connects to Neon or queries any database. It will be completed in the database/backend infrastructure phase. Until then, `/ready` must not be treated as a real readiness signal.
- **Frontend** is a placeholder page. Routing, Clerk, TanStack Query, Axios, React Hook Form and Zod are installed as dependencies but not wired up yet, and there are no API calls.
- **ML service** exposes `GET /health` and `GET /model` only. There is no `/predict` endpoint, no model is loaded for prediction, and no model has been trained. `/model` only returns the validated contents of a model's `metadata.json`; it never loads the model file.

## Local development

Prerequisites: Node.js 22.13 or newer (Vite needs 22.12+, ESLint 10 needs 22.13+) and Python 3.11 or newer.

Verified so far: Node.js 24.21 with npm 11, and Python 3.14.0. Node.js 22 (the declared minimum) and Python 3.11 to 3.13 are intended targets but have not been tested yet.

Each service has a `.env.example`. Copy it to `.env` and fill in values locally. Real `.env` files are git-ignored and must never be committed.

**Backend** (http://localhost:5000: `GET /health`, `GET /ready`)

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

**Frontend** (http://localhost:5173; it fails instead of switching port if 5173 is busy, so it keeps matching the backend's CORS setting)

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

**ML service** (http://localhost:8000: `GET /health`, and `GET /model` with an `X-Service-Secret` header)

```bash
cd ml-service
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

### Checks

Run each from the repository root:

```bash
# backend
cd backend && npm run typecheck && npm run build

# frontend
cd frontend && npm run lint && npm run build

# ML service (virtual environment active)
cd ml-service && pip check && python -c "import app.main"
```
