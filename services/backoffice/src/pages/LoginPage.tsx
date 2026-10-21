import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Card, Field } from '../components/ui';
import LedIndicator, { type LedState } from '../components/LedIndicator';
import { ApiError, loginApi } from '../lib/api';
import { captureJpeg, startCamera, stopCamera } from '../lib/camera';
import { session } from '../lib/session';
import { useCountdown } from '../lib/useCountdown';

type Step =
  | { kind: 'identifier'; blockedMessage?: string; retryAfterSeconds?: number }
  | { kind: 'face'; sessionId: string }
  | { kind: 'face-refused'; message: string }
  | { kind: 'password'; sessionId: string }
  | { kind: 'password-refused' };

const FACE_REFUSED_SECONDS = 30; // doit correspondre à FACE_REFUSED_COOLDOWN_SECONDS côté auth
const PASSWORD_REFUSED_SECONDS = 6; // doit correspondre à PASSWORD_REFUSED_COOLDOWN_SECONDS

export default function LoginPage() {
  const [step, setStep] = useState<Step>({ kind: 'identifier' });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [led, setLed] = useState<LedState>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const resetToIdentifier = (blockedMessage?: string, retryAfterSeconds = 0) => {
    stopCamera(streamRef.current);
    streamRef.current = null;
    setIdentifier('');
    setPassword('');
    setLed('off');
    setError(null);
    setStep(
      blockedMessage
        ? { kind: 'identifier', blockedMessage, retryAfterSeconds }
        : { kind: 'identifier' },
    );
  };

  // La caméra s'active dès l'entrée dans l'étape "visage", et s'arrête en la quittant.
  useEffect(() => {
    if (step.kind !== 'face' || !videoRef.current) return;
    let cancelled = false;
    startCamera(videoRef.current)
      .then((stream) => {
        if (cancelled) stopCamera(stream);
        else streamRef.current = stream;
      })
      .catch(() =>
        setError('Caméra inaccessible. Ouvrez cette page depuis le navigateur du PC Hôte.'),
      );
    return () => {
      cancelled = true;
    };
  }, [step]);

  async function submitIdentifier(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const login = await loginApi.start(identifier.trim());
      setStep({ kind: 'face', sessionId: login.session_id });
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        const minutes = Math.ceil((err.retryAfterSeconds ?? 0) / 60);
        setStep({
          kind: 'identifier',
          blockedMessage:
            err.reason === 'locked'
              ? `Trop d'échecs : bloqué ${minutes} min.`
              : `Veuillez patienter ${minutes} min avant de réessayer.`,
          retryAfterSeconds: err.retryAfterSeconds ?? 0,
        });
      } else {
        setError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitFace(sessionId: string) {
    if (!videoRef.current) return;
    setError(null);
    setBusy(true);
    try {
      const photo = await captureJpeg(videoRef.current);
      const login = await loginApi.face(sessionId, photo);
      stopCamera(streamRef.current);
      streamRef.current = null;
      setLed('green-blink');
      setStep({ kind: 'password', sessionId: login.session_id });
    } catch (err) {
      stopCamera(streamRef.current);
      streamRef.current = null;
      if (err instanceof ApiError && err.status === 401) {
        setLed('red-solid');
        setStep({
          kind: 'face-refused',
          message: err.locked
            ? `Non reconnu. Trop d'échecs : bloqué ${Math.ceil((err.retryAfterSeconds ?? 0) / 60)} min.`
            : 'Visage non reconnu.',
        });
      } else if (err instanceof ApiError && err.status === 410) {
        resetToIdentifier();
      } else {
        setError(
          err instanceof ApiError
            ? (err.detail ?? err.title)
            : 'Reconnaissance faciale indisponible.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event: FormEvent, sessionId: string) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { access_token } = await loginApi.password(sessionId, password);
      session.set(access_token);
      if (!session.get()?.roles.includes('admin')) {
        session.clear();
        setError("Ce compte n'a pas accès au back-office.");
        return;
      }
      setLed('green-solid');
      setTimeout(() => navigate('/', { replace: true }), 600);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setLed('red-blink');
        setStep({ kind: 'password-refused' });
      } else if (err instanceof ApiError && err.status === 410) {
        resetToIdentifier();
      } else {
        setError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
      }
    } finally {
      setBusy(false);
    }
  }

  // Les refus se referment tout seuls après le délai de la consigne, puis on repart de zéro.
  // `onExpire` est déclenché par le minuteur lui-même : jamais avant que le décompte n'ait vraiment
  // atteint zéro (contrairement à une comparaison faite dans un effet séparé, sujette à un rendu où
  // la valeur n'est pas encore synchronisée).
  const faceCountdown = useCountdown(
    step.kind === 'face-refused' ? FACE_REFUSED_SECONDS : null,
    () => resetToIdentifier(),
  );
  const pwdCountdown = useCountdown(
    step.kind === 'password-refused' ? PASSWORD_REFUSED_SECONDS : null,
    () => resetToIdentifier(),
  );

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 px-4">
      <h1 className="text-center text-xl font-semibold text-indigo-700">Back-office RESILIENCE</h1>
      <Card title="Authentification renforcée">
        {step.kind === 'identifier' && (
          <form onSubmit={submitIdentifier} className="space-y-4">
            <Field
              id="identifier"
              label="Identifiant"
              autoComplete="username"
              required
              disabled={Boolean(step.blockedMessage)}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
            {step.blockedMessage && <Alert kind="error">{step.blockedMessage}</Alert>}
            {error && <Alert kind="error">{error}</Alert>}
            <Button
              type="submit"
              disabled={busy || Boolean(step.blockedMessage)}
              className="w-full"
            >
              {busy ? 'Un instant…' : 'Continuer'}
            </Button>
            <LedIndicator state={led} />
          </form>
        )}

        {step.kind === 'face' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Regardez la caméra, puis vérifiez votre visage.
            </p>
            <video
              ref={videoRef}
              muted
              playsInline
              className="w-full scale-x-[-1] rounded-lg bg-black"
            />
            {error && <Alert kind="error">{error}</Alert>}
            <Button
              onClick={() => void submitFace(step.sessionId)}
              disabled={busy}
              className="w-full"
            >
              {busy ? 'Analyse…' : 'Vérifier mon visage'}
            </Button>
            <LedIndicator state={led} />
          </div>
        )}

        {step.kind === 'face-refused' && (
          <div className="space-y-3">
            <Alert kind="error">{step.message}</Alert>
            <LedIndicator state={led} />
            <p className="text-xs text-slate-500">Nouvel essai dans {faceCountdown} s…</p>
          </div>
        )}

        {step.kind === 'password' && (
          <form onSubmit={(e) => void submitPassword(e, step.sessionId)} className="space-y-4">
            <Alert kind="success">Visage reconnu.</Alert>
            <Field
              id="password"
              label="Mot de passe"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <Alert kind="error">{error}</Alert>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Un instant…' : 'Se connecter'}
            </Button>
            <LedIndicator state={led} />
          </form>
        )}

        {step.kind === 'password-refused' && (
          <div className="space-y-3">
            <Alert kind="error">Mot de passe incorrect. On recommence l'identification.</Alert>
            <LedIndicator state={led} />
          </div>
        )}
      </Card>
    </div>
  );
}
