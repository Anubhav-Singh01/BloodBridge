# BloodBridge AI: ML design (Phase 1 draft)

You train the model. This repo provides the infrastructure around it. No real performance is claimed anywhere.

## 1. Role and boundary

The model ranks donors who have already passed every hard filter: compatibility, verification, availability, donation interval, fatigue cap, and geographic radius. It cannot approve a donor, override eligibility, or determine medical fitness. The backend sends only filtered donors and ignores any returned donor id it did not send.

## 2. Target

`P(donor accepts | donor notified)`. Label from `donor_responses`: ACCEPTED = 1; DECLINED, NO_RESPONSE, EXPIRED = 0. Unit of prediction: one (search, donor) row.

Notes and caveats:
- WAITLISTED is still an acceptance, so it is labelled 1. Acceptance is not the same as actually donating.
- NO_RESPONSE conflates "did not see" with "chose not to respond". Record `delivery_status` and `seen_at` to separate these later.
- Selection bias: only notified donors have labels. Donors ranked low are never contacted, so a model trained on this data learns from the earlier ranker's choices. The ranker version, predictions and outcomes are logged so this bias can be analysed later. Randomised exploration is deferred beyond v1 and is not part of the v1 ranking or contact flow.
- The fulfilment confirmation is requester-only, so it is a weak label for "actually donated". That is why the target is acceptance, not donation.

## 3. Metrics

Because ranking within a batch is the goal: Precision@K and Recall@K (K = batch size), PR-AUC, ROC-AUC, calibration curve and Brier score, plus log loss. Accuracy is not used. Splits are time-based (train on earlier searches, test on later) and grouped by request so a request never appears in both. Report by urgency and by city to expose uneven performance.

## 4. Feature audit (available at ranking time?)

| Feature | Use | At ranking time | Leakage | Privacy / fairness |
|---|---|---|---|---|
| distance_km | Nearer donors respond more | Yes | No | Location-sensitive, not exposed |
| eta_minutes | Practical travel time | Yes (cached estimate) | No | As above |
| response_rate_prior | Past accepts / notifications | Yes, computed strictly from events before this notification | Yes if the current search's outcome is included | Fine |
| avg_response_seconds_prior | Speed | Yes, prior events only | Same | Fine |
| recent_activity_days | Engagement | Yes | No | Fine |
| prior_successful_donations | Reliability | Yes | No | Fine |
| days_since_last_donation | Freshness | Yes | No | Medical-adjacent, use as context only, never as eligibility |
| urgency, is_emergency | Motivation | Yes | No | Fine |
| hour_of_day, day_of_week | Availability pattern | Yes | No | Fine |
| notifications_last_24h | Fatigue | Yes | No | Fine |
| batch_number | Excluded from v1 features | Yes | Feedback loop: it is determined by the previous ranking and selection (later batches only contain donors the ranker placed lower), so using it would make the model learn its own earlier ordering. Still stored for audit and analytics | Not a model input |
| blood_group category (rarity) | Excluded from v1 features | Yes | No | Sensitive medical data. Compatibility and blood-group rules remain hard backend filters, applied before ranking. May be reconsidered later after sufficient real data and a privacy/fairness review |
| age, gender, religion, caste, name | Not used | | | Excluded for fairness and privacy |

Excluded because they occur after ranking: anything from the response itself (response time for this notification, whether donor arrived, donation completed). The `feature_snapshot` is stored on `ranking_predictions` (append-only, one row per donor per ranking run) at ranking time, so training data can never include later information. The prediction actually used to contact a donor is the row referenced by `donor_matches.selected_prediction_id`. Predictions for donors who were ranked but not contacted are kept too, but they have no outcome label. The pipeline includes a leakage test that recomputes prior-history features from timestamps and fails if any source event is later than the notification time.

## 5. Service

`ml-service/` FastAPI. `POST /predict` (secret-protected), `GET /health`, `GET /model` (version and metadata). The model is loaded from a versioned artifact (`models/<model_version>/model.joblib` and `metadata.json` holding algorithm, dataset_version, features_used, metrics, training date). Missing model returns 503 and the backend falls back.

Request:
```json
{ "request": { "urgency": "HIGH", "isEmergency": true, "hourOfDay": 14, "dayOfWeek": 3 },
  "donors": [ { "id": "uuid", "distanceKm": 2.4, "etaMinutes": 8, "responseRatePrior": 0.81 } ] }
```
Response:
```json
{ "modelVersion": "donor-response-v1", "predictions": [ { "donorId": "uuid", "score": 0.87, "reasons": ["NEARBY","FAST_RESPONSE"] } ] }
```
`reasons` are coarse operational labels (Nearby, Currently available, Fast historical response, High recent activity) derived from feature thresholds or SHAP for tree models. Raw scores and model internals are shown to admins only, never to patients or donors. The `model_version` and `ranker_type` are stored on the `ranking_runs` row that every `ranking_predictions` row belongs to.

## 6. Fallback ranker

Transparent weighted score over distance, ETA, prior response rate, recent activity, with weights in `settings`. Stored as `model_version='rule-based-fallback'`. Used when no model is active or the service is down (short timeout, circuit breaker). It is never presented as ML.

## 7. Training infrastructure

```
ml-service/training/: preprocess.py  feature_engineering.py  train.py  evaluate.py
```
Flow: export events, clean, engineer features, time-based split, train, evaluate, select, serialise, register a version. The comparison set is fixed as Logistic Regression, Random Forest and XGBoost, selectable by config. The final algorithm is selected later, based on time-based validation results on real data. Nothing in this repository asserts or presumes any model's performance. Metrics are produced by your own training runs and saved beside the artifact.

Data: none exists yet. A clearly-labelled synthetic generator (`datasets/synthetic_DO_NOT_REPORT.csv`) exists only to test the pipeline end to end. Its metrics must never be reported as real. Real data will accumulate from the app's feedback loop.

## 8. Feedback loop and governance

Every ranking run stores its candidates, ranks, scores, model version and features in `ranking_runs` and `ranking_predictions`, and outcomes are stored in `donor_responses`. Training rows are built by joining the prediction selected for contact (`donor_matches.selected_prediction_id`) to the donor's response. No automatic retraining or auto-deployment. A new `ml_model_versions` row starts as CANDIDATE and is activated by an admin action, which is audit-logged and reversible.

## 9. Resolved decisions for v1

- **Algorithms:** the comparison set is Logistic Regression, Random Forest and XGBoost. The final choice is made later from time-based validation results. No performance figures are stated or invented here.
- **Blood-group rarity:** excluded from the v1 ranking model. Compatibility and blood-group rules stay hard backend filters. It may be reconsidered after sufficient real data and a privacy/fairness review.
- **Exploration:** randomised exploration is deferred beyond v1. The selection-bias discussion in section 2 and the ranking and outcome logging stay in place for future analysis.
- **`batch_number`:** excluded from the v1 feature set because it can create a feedback loop with the earlier ranking and selection. It is still stored for audit and analytics.
