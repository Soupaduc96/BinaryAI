"""BinaryAI AI service -- reference skeleton.

NOT IMPLEMENTED and NOT RUN. This file exists so the boundary described in
services/ai/contract/ai-service.md has a concrete starting point in the language
where the ML work belongs.

Every capability reports `not_implemented` and every inference endpoint returns
501. That is the honest state of the AI layer: interfaces exist, models do not.
Filling one in means training something real and flipping its capability entry
to the implementation kind that is actually behind it.

Run (once dependencies exist):
    pip install -r requirements.txt
    uvicorn app.main:app --port 8000
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

SERVICE_NAME = "binaryai-ai-python"
SERVICE_VERSION = "0.1.0"

ImplementationKind = Literal["rule_based", "statistical_model", "llm", "not_implemented"]

app = FastAPI(title="BinaryAI AI Service", version=SERVICE_VERSION)


class Capability(BaseModel):
    capability: str
    implementation: ImplementationKind
    available: bool
    notes: str


class CapabilitiesResponse(BaseModel):
    provider: str = SERVICE_NAME
    capabilities: list[Capability]


class ExplainRequest(BaseModel):
    signal: dict[str, Any]
    analysis: dict[str, Any]
    locale: str | None = Field(default="en")


# Single source of truth for what this service can actually do. It is a lie
# detector: if an endpoint starts returning real output, its entry here has to
# change with it, and the dashboard shows the change immediately.
CAPABILITIES: list[Capability] = [
    Capability(
        capability=name,
        implementation="not_implemented",
        available=False,
        notes="Interface defined; no model trained.",
    )
    for name in (
        "explanation",
        "regime_classification",
        "signal_ranking",
        "anomaly_detection",
        "pattern_matching",
        "strategy_optimization",
    )
]


def not_implemented(capability: str) -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "not_implemented",
                "message": (
                    f"Capability '{capability}' is not implemented. "
                    "BinaryAI falls back to its local rule-based provider."
                ),
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME, "version": SERVICE_VERSION}


@app.get("/v1/capabilities", response_model=CapabilitiesResponse)
def capabilities() -> CapabilitiesResponse:
    return CapabilitiesResponse(capabilities=CAPABILITIES)


@app.post("/v1/explain")
def explain(_request: ExplainRequest) -> JSONResponse:
    # An implementation must explain ONLY the facts in the payload, must state
    # that the confidence figure is uncalibrated, and must not give advice.
    return not_implemented("explanation")


@app.post("/v1/classify-regime")
def classify_regime(_payload: dict[str, Any]) -> JSONResponse:
    return not_implemented("regime_classification")


@app.post("/v1/calibrate-confidence")
def calibrate_confidence(_payload: dict[str, Any]) -> JSONResponse:
    # The capability that matters most. Blocked on data: it needs a few thousand
    # settled signals in `signal_outcomes` before a calibration curve means
    # anything. See docs/ai-architecture.md.
    return not_implemented("confidence_calibration")
