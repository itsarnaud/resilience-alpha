import { useState } from 'react';
import { Alert, Button, Card } from '../components/ui';
import { ApiError, paymentsApi } from '../lib/api';
import { formatEuros } from '../lib/money';
import { useLoad } from '../lib/useLoad';

export default function AccountsPage() {
  const { data: accounts, error, loading, reload } = useLoad(paymentsApi.accounts);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setOpenError(null);
    try {
      await paymentsApi.openAccount();
      await reload();
    } catch (err) {
      setOpenError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Mes comptes</h1>
        <Button onClick={open} disabled={opening}>
          {opening ? 'Ouverture…' : 'Ouvrir un compte'}
        </Button>
      </div>
      {error && <Alert kind="error">{error.detail ?? error.title}</Alert>}
      {openError && <Alert kind="error">{openError}</Alert>}
      {loading && !accounts && <p className="text-sm text-slate-500">Chargement…</p>}
      {accounts?.length === 0 && (
        <Alert kind="info">Vous n'avez pas encore de compte. Ouvrez-en un pour commencer.</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {accounts?.map((account) => (
          <Card key={account.id}>
            <p className="text-xs uppercase tracking-wide text-slate-500">Compte courant</p>
            <p className="mt-1 text-2xl font-semibold">{formatEuros(account.balance_cents)}</p>
            <p className="mt-2 break-all font-mono text-xs text-slate-600">{account.iban}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
