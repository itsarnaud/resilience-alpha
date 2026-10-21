import { useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import { Alert, Button, Card, Field } from '../components/ui';
import { assistantApi, type AssistantAnswer, ApiError } from '../lib/api';

// Rendu minimal du markdown renvoyé par l'assistant (gras, listes, code) : pas de titres ni
// d'images, une réponse reste un paragraphe de texte, pas une page.
const markdownComponents = {
  p: (props: React.ComponentPropsWithoutRef<'p'>) => <p className="mb-2 last:mb-0" {...props} />,
  strong: (props: React.ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold text-slate-900" {...props} />
  ),
  code: (props: React.ComponentPropsWithoutRef<'code'>) => (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs" {...props} />
  ),
  ul: (props: React.ComponentPropsWithoutRef<'ul'>) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0" {...props} />
  ),
  ol: (props: React.ComponentPropsWithoutRef<'ol'>) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0" {...props} />
  ),
};

export default function AssistantPage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setAnswer(await assistantApi.chat(question));
    } catch (err) {
      setAnswer(null);
      setError(err instanceof ApiError ? err : new ApiError(0, 'Erreur inattendue'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Assistant</h1>
      <Card>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field
            id="question"
            label="Question"
            hint="Répond à partir de la documentation du projet (sujet, architecture, API)."
            required
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button type="submit" disabled={loading || !question.trim()}>
            {loading ? 'Recherche…' : 'Demander'}
          </Button>
        </form>
      </Card>
      {error && <Alert kind="error">{error.detail ?? error.title}</Alert>}
      {answer && (
        <Card title="Réponse">
          <div className="text-sm text-slate-800">
            <Markdown components={markdownComponents}>{answer.answer}</Markdown>
          </div>
          {answer.sources.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4">
              {answer.sources.map((source, i) => (
                <li key={i}>
                  <details className="group">
                    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                      <span className="font-mono">{source.file}</span>
                      {source.page !== null && <span> (page {source.page})</span>}
                    </summary>
                    <p className="mt-1 pl-3 text-xs italic text-slate-400">« {source.excerpt} »</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
