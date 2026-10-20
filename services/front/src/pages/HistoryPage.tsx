import { useState } from 'react';
import { Alert, Badge, Button, Card } from '../components/ui';
import { ApiError, paymentsApi, type Transaction } from '../lib/api';
import { formatEuros } from '../lib/money';
import { refusalMessage } from '../lib/refusals';
import { useLoad } from '../lib/useLoad';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export default function HistoryPage() {
  const accounts = useLoad(paymentsApi.accounts);
  const first = useLoad(() => paymentsApi.transactions());
  const [more, setMore] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const mine = new Set(accounts.data?.map((a) => a.id));
  const items = [...(first.data?.items ?? []), ...more];
  const nextCursor = cursor === undefined ? (first.data?.next_cursor ?? null) : cursor;

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await paymentsApi.transactions(nextCursor);
      setMore((previous) => [...previous, ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setMoreError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Historique</h1>
      {first.error && <Alert kind="error">{first.error.detail ?? first.error.title}</Alert>}
      {first.loading && !first.data && <p className="text-sm text-slate-500">Chargement…</p>}
      {first.data && items.length === 0 && (
        <Alert kind="info">Aucune opération pour le moment.</Alert>
      )}
      <Card>
        <ul className="divide-y divide-slate-100">
          {items.map((t) => {
            const outgoing = mine.has(t.from_account_id);
            const refused = t.status === 'REJECTED';
            return (
              <li key={t.id} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {t.label || (outgoing ? 'Virement émis' : 'Virement reçu')}
                  </p>
                  <p className="text-xs text-slate-500">{date.format(new Date(t.created_at))}</p>
                  {refused && (
                    <p className="mt-1 text-xs text-red-700">{refusalMessage(t.reject_reason)}</p>
                  )}
                </div>
                <div className="text-right">
                  <p
                    className={`text-sm font-semibold ${refused ? 'text-slate-400 line-through' : outgoing ? 'text-slate-900' : 'text-emerald-700'}`}
                  >
                    {outgoing ? '−' : '+'}
                    {formatEuros(t.amount_cents)}
                  </p>
                  <Badge tone={refused ? 'ko' : 'ok'}>{refused ? 'Refusé' : 'Exécuté'}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      {moreError && <Alert kind="error">{moreError}</Alert>}
      {nextCursor && (
        <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Chargement…' : 'Voir plus'}
        </Button>
      )}
    </>
  );
}
