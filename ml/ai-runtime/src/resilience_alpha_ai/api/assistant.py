"""Authenticated API for the local documentary assistant."""

import logging
import os
from pathlib import Path
from threading import Lock
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from resilience_alpha_ai.api.security import operator_dependency
from resilience_alpha_ai.rag.assistant import answer_question
from resilience_alpha_ai.rag.retrieval import build_vector_store

logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    incident_id: UUID | None = None


class Source(BaseModel):
    file: str
    excerpt: str
    page: int | None = None


class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]


def create_app() -> FastAPI:
    authorize = operator_dependency(
        os.environ["AUTH_JWKS_URL"],
        os.getenv("JWT_ISSUER", "resilience-auth"),
        os.getenv("JWT_AUDIENCE", "resilience-platform"),
    )
    folder = Path(os.getenv("RAG_KNOWLEDGE_DIR", "data/knowledge_base"))
    app = FastAPI(title="Resilience Alpha Assistant")
    gate = Lock()
    store = None

    @app.get("/assistant/healthz")
    def health():
        return {"status": "alive", "service": "rag-assistant-api"}

    @app.post("/assistant/v1/chat", response_model=ChatResponse)
    def chat(body: ChatRequest, _claims=Depends(authorize)):
        nonlocal store

        question = body.question.strip()
        if not question:
            raise HTTPException(422, "Question must not be blank")

        if body.incident_id is not None:
            raise HTTPException(
                422,
                "Incident context is not connected yet; omit incident_id",
            )

        if not gate.acquire(blocking=False):
            raise HTTPException(
                503, "Assistant is busy; retry later",
                headers={"Retry-After": "5"},
            )

        try:
            if store is None:
                store = build_vector_store(folder)

            result = answer_question(store, question)
            return ChatResponse(
                answer=result["answer"],
                sources=[
                    Source(
                        file=str(doc.metadata["source"]),
                        excerpt=doc.page_content,
                        page=doc.metadata.get("page"),
                    )
                    for doc in result["sources"]
                ],
            )
        except Exception:
            logger.exception("Documentary assistant request failed")
            raise HTTPException(
                503, "Assistant unavailable; check documents and Ollama"
            ) from None
        finally:
            gate.release()

    return app
