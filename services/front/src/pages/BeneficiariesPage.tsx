import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field } from '../components/ui';
import { ApiError, paymentsApi } from '../lib/api';
import { useLoad } from '../lib/useLoad';

export default function BeneficiariesPage() {
  const { data, error, loading, reload } = useLoad(paymentsApi.beneficiaries);
  const [iban, setIban] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await paymentsApi.addBeneficiary(iban, label.trim());
      setIban('');
      setLabel('');
      await reload();
    } catch (err) {
      const text =
        err instanceof ApiError && err.status === 409
          ? 'Ce bénéficiaire existe déjà.'
          : err instanceof ApiError && err.status === 422
            ? 'IBAN invalide (par exemple FR7612345678901234567890123) ou libellé manquant.'
            : err instanceof ApiError
              ? (err.detail ?? err.title)
              : 'Erreur inattendue.';
      setFormError(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Bénéficiaires</h1>
      <Card title="Ajouter un bénéficiaire">
        <form onSubmit={submit} className="space-y-4">
          <Field
            id="b-iban"
            label="IBAN"
            required
            value={iban}
            onChange={(e) => setIban(e.target.value)}
          />
          <Field
            id="b-label"
            label="Nom du bénéficiaire"
            required
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {formError && <Alert kind="error">{formError}</Alert>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Ajout…' : 'Ajouter'}
          </Button>
        </form>
      </Card>
      <Card title="Ma liste">
        {error && <Alert kind="error">{error.detail ?? error.title}</Alert>}
        {loading && !data && <p className="text-sm text-slate-500">Chargement…</p>}
        {data?.length === 0 && (
          <p className="text-sm text-slate-500">Aucun bénéficiaire pour le moment.</p>
        )}
        <ul className="divide-y divide-slate-100">
          {data?.map((b) => (
            <li key={b.id} className="py-2">
              <p className="text-sm font-medium">{b.label}</p>
              <p className="break-all font-mono text-xs text-slate-600">{b.iban}</p>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
