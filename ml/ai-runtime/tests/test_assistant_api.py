import os
import unittest
from unittest.mock import patch

from fastapi import Header, HTTPException
from fastapi.testclient import TestClient
from langchain_core.documents import Document

from resilience_alpha_ai.api.assistant import create_app


def mock_authorize(authorization: str | None = Header(default=None)):
    if authorization != "Bearer test-token":
        raise HTTPException(401, "Unauthorized")
    return {"roles": ["operator"]}


class AssistantApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "AUTH_JWKS_URL": "http://auth.invalid/.well-known/jwks.json",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

        self.auth = patch(
            "resilience_alpha_ai.api.assistant.operator_dependency",
            return_value=mock_authorize,
        )
        self.auth.start()
        self.addCleanup(self.auth.stop)

        self.build = patch(
            "resilience_alpha_ai.api.assistant.build_vector_store"
        )
        self.builder = self.build.start()
        self.addCleanup(self.build.stop)

        self.answer = patch(
            "resilience_alpha_ai.api.assistant.answer_question",
            return_value={
                "answer": "Ollama et LangChain. [1]",
                "sources": [Document(
                    page_content="Utiliser Ollama et LangChain.",
                    metadata={"source": "subject.pdf", "page": 5},
                )],
            },
        )
        self.responder = self.answer.start()
        self.addCleanup(self.answer.stop)

        self.client = TestClient(create_app())
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer test-token"}

    def test_health_and_missing_token(self):
        self.assertEqual(
            self.client.get("/assistant/healthz").status_code, 200
        )
        response = self.client.post(
            "/assistant/v1/chat", json={"question": "Technologies ?"}
        )
        self.assertEqual(response.status_code, 401)
        self.builder.assert_not_called()
        self.responder.assert_not_called()

    def test_sources_and_index_reuse(self):
        for _ in range(2):
            response = self.client.post(
                "/assistant/v1/chat",
                json={"question": "Technologies ?"},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["sources"][0], {
                "file": "subject.pdf",
                "excerpt": "Utiliser Ollama et LangChain.",
                "page": 5,
            })
        self.builder.assert_called_once()
        self.assertEqual(self.responder.call_count, 2)

    def test_invalid_questions(self):
        for question in ("   ", "x" * 2001):
            response = self.client.post(
                "/assistant/v1/chat",
                json={"question": question},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, 422)
        self.builder.assert_not_called()

    def test_unavailable_then_recovery(self):
        self.responder.side_effect = [
            RuntimeError("Ollama unavailable"),
            {"answer": "Information absente.", "sources": []},
        ]
        for expected in (503, 200):
            response = self.client.post(
                "/assistant/v1/chat",
                json={"question": "Technologies ?"},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, expected)


if __name__ == "__main__":
    unittest.main()
