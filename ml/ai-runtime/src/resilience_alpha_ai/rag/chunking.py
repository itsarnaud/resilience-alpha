"""Split document pages into passages for retrieval."""

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from resilience_alpha_ai.rag.document_loader import load_pdf_documents


def split_documents(
    documents: list[Document],
    chunk_size: int = 1000,
    chunk_overlap: int = 150,
) -> list[Document]:
    """Split pages independently, preserving their metadata."""
    if chunk_size <= 0 or not 0 <= chunk_overlap < chunk_size:
        raise ValueError("Require chunk_size > 0 and 0 <= overlap < chunk_size.")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks = splitter.split_documents(documents)

    for index, chunk in enumerate(chunks):
        chunk.metadata["chunk_id"] = index

    return chunks


if __name__ == "__main__":
    from pathlib import Path

    documents = load_pdf_documents(Path("data/knowledge_base"))
    chunks = split_documents(documents)

    print(f"Pages: {len(documents)}")
    print(f"Passages: {len(chunks)}")

    example = next(chunk for chunk in chunks if chunk.metadata["page"] == 5)
    print(f"\nSource: {example.metadata}")
    print(f"\nExample passage:\n{example.page_content}")
