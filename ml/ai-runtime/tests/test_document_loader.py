import tempfile
from pathlib import Path
import unittest
import pymupdf
from resilience_alpha_ai.rag.document_loader import load_documents

class DocumentLoaderTests(unittest.TestCase):
    def test_mixed_corpus_preserves_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'docs').mkdir()
            (root/'docs'/'architecture.md').write_text('# Architecture\nAuth calls face.',encoding='utf-8-sig')
            (root/'procedure.txt').write_text('Restart procedure',encoding='utf-8')
            pdf=pymupdf.open();page=pdf.new_page();page.insert_text((30,30),'Workshop requirements');pdf.save(root/'subject.pdf');pdf.close()
            docs=load_documents(root)
            self.assertEqual({d.metadata['source'] for d in docs},{'docs/architecture.md','procedure.txt','subject.pdf'})
            self.assertEqual(next(d.metadata['page'] for d in docs if d.metadata['source']=='subject.pdf'),1)
            self.assertIsNone(next(d.metadata['page'] for d in docs if d.metadata['source'].endswith('.md')))
    def test_hidden_and_unsupported_files_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'.private.md').write_text('ignore');(root/'data.json').write_text('{}');(root/'ok.md').write_text('public')
            self.assertEqual(len(load_documents(root)),1)
    def test_empty_and_missing_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):load_documents(Path(temp))
            with self.assertRaises(FileNotFoundError):load_documents(Path(temp)/'missing')

if __name__=='__main__':unittest.main()
