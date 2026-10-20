import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, Field } from '../components/ui';
import { ApiError, authApi } from '../lib/api';
import { session } from '../lib/session';

const MESSAGES: Record<number, string> = {
  401: 'Identifiant ou mot de passe incorrect.',
  409: 'Un compte existe déjà avec cet e-mail.',
  422: 'Informations invalides : e-mail valide, mot de passe de 12 caractères minimum (72 octets maximum).',
};

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
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
      if (mode === 'register') await authApi.register(email, password);
      const { access_token } = await authApi.login(email, password);
      session.set(access_token);
      // Cet espace est réservé aux clients : un compte d'administration passe par le back-office.
      if (!session.get()?.roles.includes('customer')) {
        session.clear();
        setError("Ce compte n'a pas accès à l'espace client.");
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        MESSAGES[status] ??
          (err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 px-4">
      <h1 className="text-center text-xl font-semibold text-indigo-700">Banque RESILIENCE</h1>
      <Card title={mode === 'login' ? 'Connexion' : 'Créer un compte'}>
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
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            hint={mode === 'register' ? '12 caractères minimum.' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <Alert kind="error">{error}</Alert>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Un instant…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-slate-600">
        {mode === 'login' ? 'Pas encore de compte ?' : 'Déjà un compte ?'}{' '}
        <button
          type="button"
          className="font-medium text-indigo-700 underline"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Créer un compte' : 'Se connecter'}
        </button>
      </p>
    </div>
  );
}
