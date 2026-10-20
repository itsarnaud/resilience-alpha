import { useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field } from '../components/ui';
import { ApiError, paymentsApi } from '../lib/api';
import { eurosToCents, formatEuros } from '../lib/money';
import { refusalMessage } from '../lib/refusals';
import { useLoad } from '../lib/useLoad';
import { uuid } from '../lib/uuid';

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const MAX_CENTS = 1_000_000;

type Outcome = { kind: 'success' | 'error'; text: string };

export default function TransferPage() {
  const accounts = useLoad(paymentsApi.accounts);
  const beneficiaries = useLoad(paymentsApi.beneficiaries);

  const [fromId, setFromId] = useState('');
  const [iban, setIban] = useState('');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Une même demande garde la même clé d'idempotence : si la réponse se perd (réseau), le nouvel
  // envoi ne débite pas deux fois. La clé n'est renouvelée qu'après une réponse définitive.
  const idempotencyKey = useRef(uuid());

  const list = accounts.data ?? [];
  const sourceId = fromId || list[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setOutcome(null);

    const cents = eurosToCents(amount);
    const target = iban.replace(/\s+/g, '').toUpperCase();
    if (!sourceId) return setOutcome({ kind: 'error', text: 'Choisissez le compte à débiter.' });
    if (!IBAN.test(target))
      return setOutcome({ kind: 'error', text: "L'IBAN du destinataire est invalide." });
    if (cents === null || cents <= 0)
      return setOutcome({ kind: 'error', text: 'Montant invalide.' });
    if (cents > MAX_CENTS) {
      return setOutcome({ kind: 'error', text: `Montant maximum : ${formatEuros(MAX_CENTS)}.` });
    }

    setBusy(true);
    try {
      await paymentsApi.transfer(
        {
          from_account_id: sourceId,
          to_iban: target,
          amount_cents: cents,
          label: label.trim() || undefined,
        },
        idempotencyKey.current,
      );
      idempotencyKey.current = uuid();
      setOutcome({ kind: 'success', text: `Virement de ${formatEuros(cents)} effectué.` });
      setAmount('');
      setLabel('');
      await accounts.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        idempotencyKey.current = uuid(); // réponse définitive : une nouvelle tentative est une nouvelle demande
      }
      const text =
        err instanceof ApiError
          ? (refusalMessage(err.reason) ??
            (err.status === 0
              ? `${err.title}. Vous pouvez réessayer sans risque de double débit.`
              : (err.detail ?? err.title)))
          : 'Erreur inattendue.';
      setOutcome({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Faire un virement</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="from" className="block text-sm font-medium text-slate-700">
              Compte à débiter
            </label>
            <select
              id="from"
              value={sourceId}
              onChange={(e) => setFromId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatEuros(a.balance_cents)} — {a.iban}
                </option>
              ))}
            </select>
            {accounts.data?.length === 0 && (
              <p className="text-xs text-slate-500">Ouvrez d'abord un compte depuis « Comptes ».</p>
            )}
          </div>
          <Field
            id="iban"
            label="IBAN du destinataire"
            list="known-ibans"
            autoComplete="off"
            required
            value={iban}
            onChange={(e) => setIban(e.target.value)}
          />
          <datalist id="known-ibans">
            {beneficiaries.data?.map((b) => (
              <option key={b.id} value={b.iban}>
                {b.label}
              </option>
            ))}
          </datalist>
          <Field
            id="amount"
            label="Montant (€)"
            inputMode="decimal"
            placeholder="12,50"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Field
            id="label"
            label="Libellé (facultatif)"
            maxLength={140}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {outcome && <Alert kind={outcome.kind}>{outcome.text}</Alert>}
          <Button type="submit" disabled={busy || list.length === 0}>
            {busy ? 'Envoi…' : 'Envoyer le virement'}
          </Button>
        </form>
      </Card>
    </>
  );
}
