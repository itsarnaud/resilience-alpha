"""Load local PDF, Markdown and text documents with source references."""
from pathlib import Path
import pymupdf
from langchain_core.documents import Document


def load_documents(folder: Path) -> list[Document]:
    folder = Path(folder)
    if not folder.is_dir():
        raise FileNotFoundError(f'Document folder not found: {folder}')
    documents = []
    for path in sorted(folder.rglob('*')):
        if not path.is_file() or path.is_symlink() or path.suffix.lower() not in {'.pdf', '.md', '.txt'}:
            continue
        if any(part.startswith('.') for part in path.relative_to(folder).parts):
            continue
        source = path.relative_to(folder).as_posix()
        if path.suffix.lower() == '.pdf':
            with pymupdf.open(path) as pdf:
                for number, page in enumerate(pdf, 1):
                    text = page.get_text(sort=True).strip()
                    if text:
                        documents.append(Document(page_content=text, metadata={'source':source,'page':number}))
        else:
            text = path.read_text(encoding='utf-8-sig').strip()
            if text:
                documents.append(Document(page_content=text, metadata={'source':source,'page':None}))
    if not documents:
        raise ValueError(f'No extractable PDF, Markdown or text documents in: {folder}')
    return documents


# Compatibility for existing callers; new callers should use load_documents.
load_pdf_documents = load_documents

if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,default=Path('data/knowledge_base'))
    docs=load_documents(parser.parse_args().input_dir)
    print(f'Loaded {len(docs)} document sections.')
    for doc in docs:
        print(f"{doc.metadata['source']} | page {doc.metadata['page']} | {len(doc.page_content)} characters")
