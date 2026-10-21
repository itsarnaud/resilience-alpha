"""Retrieve relevant passages from local PDF documents."""

import os
from pathlib import Path

from langchain_core.vectorstores import InMemoryVectorStore
from langchain_ollama import OllamaEmbeddings

from resilience_alpha_ai.rag.chunking import split_documents
from resilience_alpha_ai.rag.document_loader import load_pdf_documents


def build_vector_store(folder: Path) -> InMemoryVectorStore:
    documents = load_pdf_documents(folder)
    chunks = split_documents(documents)

    embeddings = OllamaEmbeddings(
        model="embeddinggemma:300m",
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
    )

    print(f"Indexing {len(chunks)} passages...")
    return InMemoryVectorStore.from_documents(chunks, embedding=embeddings)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path("data/knowledge_base"),
    )
    args = parser.parse_args()

    store = build_vector_store(args.input_dir)
    results = store.similarity_search(args.question, k=3)

    for rank, document in enumerate(results, start=1):
        metadata = document.metadata
        print(
            f"\n[{rank}] {metadata['source']} | "
            f"page {metadata['page']} | passage {metadata['chunk_id']}"
        )
        print(document.page_content)
