import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, Field } from '../components/ui';
import { ApiError, authApi } from '../lib/api';
import { session } from '../lib/session';

const MESSAGES: Record<number, string> = { 401: 'Identifiant ou mot de passe incorrect.' };

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { access_token } = await authApi.login(email, password);
      session.set(access_token);
      if (!session.get()?.roles.includes('operator')) {
        session.clear();
        setError("Ce compte n'a pas accès à la supervision.");
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(MESSAGES[status] ?? (err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 px-4">
      <h1 className="text-center text-xl font-semibold text-indigo-700">Supervision RESILIENCE</h1>
      <Card title="Connexion opérateur">
        <form onSubmit={submit} className="space-y-4">
          <Field
            id="email"
            label="Adresse e-mail"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            id="password"
            label="Mot de passe"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <Alert kind="error">{error}</Alert>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Un instant…' : 'Se connecter'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
