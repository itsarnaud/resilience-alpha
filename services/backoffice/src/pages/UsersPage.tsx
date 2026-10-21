import { useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field } from '../components/ui';
import { ApiError, adminApi, type UserSummary } from '../lib/api';
import { captureJpeg, startCamera, stopCamera } from '../lib/camera';
import { useLoad } from '../lib/useLoad';

const ROLES = ['customer', 'operator', 'admin'] as const;
const ROLE_LABELS: Record<string, string> = {
  customer: 'Client',
  operator: 'Opérateur',
  admin: 'Administrateur',
};
const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

/** Capture une photo en pleine page (caméra, bouton, aperçu), pour l'enrôlement d'un visage. */
function FaceCaptureModal({
  onCapture,
  onCancel,
}: {
  onCapture: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attachVideo = (video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (!video || streamRef.current) return;
    startCamera(video)
      .then((stream) => (streamRef.current = stream))
      .catch(() => setError('Caméra inaccessible.'));
  };

  const capture = async () => {
    if (!videoRef.current) return;
    const blob = await captureJpeg(videoRef.current);
    stopCamera(streamRef.current);
    onCapture(blob);
  };

  const cancel = () => {
    stopCamera(streamRef.current);
    onCancel();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
      <Card title="Enrôler un visage">
        <div className="w-80 space-y-3">
          <video
            ref={attachVideo}
            muted
            playsInline
            className="w-full scale-x-[-1] rounded-lg bg-black"
          />
          {error && <Alert kind="error">{error}</Alert>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={cancel} className="flex-1">
              Annuler
            </Button>
            <Button onClick={() => void capture()} className="flex-1">
              Capturer
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function UsersPage() {
  const { data, error, loading, reload } = useLoad(adminApi.users);
  const [enrollingFor, setEnrollingFor] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<string[]>(['operator']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [identifier, setIdentifier] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockMessage, setUnlockMessage] = useState<string | null>(null);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await adminApi.createUser(email.trim(), password, roles);
      setEmail('');
      setPassword('');
      setRoles(['operator']);
      await reload();
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.status === 409
            ? 'Un compte existe déjà avec cet email.'
            : (err.detail ?? err.title)
          : 'Erreur inattendue.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(user: UserSummary) {
    setRowError(null);
    try {
      await adminApi.updateUser(user.id, { active: !user.active });
      await reload();
    } catch (err) {
      setRowError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
    }
  }

  async function toggleRole(user: UserSummary, role: string) {
    setRowError(null);
    const nextRoles = user.roles.includes(role)
      ? user.roles.filter((r) => r !== role)
      : [...user.roles, role];
    if (nextRoles.length === 0) return;
    try {
      await adminApi.updateUser(user.id, { roles: nextRoles });
      await reload();
    } catch (err) {
      setRowError(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
    }
  }

  async function enroll(userId: string, blob: Blob) {
    setEnrollingFor(null);
    setRowError(null);
    setRowMessage(null);
    try {
      const { samples } = await adminApi.enrollFace(userId, blob);
      setRowMessage(`Visage enrôlé (${samples} échantillon${samples > 1 ? 's' : ''}).`);
    } catch (err) {
      setRowError(
        err instanceof ApiError && err.status === 422
          ? 'Aucun visage détecté sur la photo : reprenez-la, visage bien visible et centré.'
          : err instanceof ApiError
            ? (err.detail ?? err.title)
            : 'Erreur inattendue.',
      );
    }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setUnlockMessage(null);
    setUnlocking(true);
    try {
      await adminApi.unlock(identifier.trim());
      setUnlockMessage(`${identifier.trim()} débloqué.`);
      setIdentifier('');
    } catch (err) {
      setUnlockMessage(err instanceof ApiError ? (err.detail ?? err.title) : 'Erreur inattendue.');
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Habilitations</h1>

      <Card title="Créer un compte">
        <form onSubmit={createUser} className="space-y-4">
          <Field
            id="new-email"
            label="E-mail"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            id="new-password"
            label="Mot de passe"
            type="password"
            required
            hint="12 caractères minimum."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-slate-700">Rôles</legend>
            <div className="flex gap-3">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(e) =>
                      setRoles(
                        e.target.checked ? [...roles, role] : roles.filter((r) => r !== role),
                      )
                    }
                  />
                  {ROLE_LABELS[role]}
                </label>
              ))}
            </div>
          </fieldset>
          {createError && <Alert kind="error">{createError}</Alert>}
          <Button type="submit" disabled={creating || roles.length === 0}>
            {creating ? 'Création…' : 'Créer le compte'}
          </Button>
        </form>
      </Card>

      <Card title="Comptes">
        {error && <Alert kind="error">{error.detail ?? error.title}</Alert>}
        {rowError && <Alert kind="error">{rowError}</Alert>}
        {rowMessage && <Alert kind="success">{rowMessage}</Alert>}
        {loading && !data && <p className="text-sm text-slate-500">Chargement…</p>}
        <ul className="divide-y divide-slate-100">
          {data?.map((user) => (
            <li key={user.id} className="space-y-2 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{user.email}</p>
                  <p className="text-xs text-slate-500">
                    Créé le {date.format(new Date(user.created_at))}
                  </p>
                </div>
                <Badge tone={user.active ? 'ok' : 'ko'}>
                  {user.active ? 'Actif' : 'Désactivé'}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {ROLES.map((role) => (
                  <label key={role} className="flex items-center gap-1 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={user.roles.includes(role)}
                      onChange={() => void toggleRole(user, role)}
                    />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void toggleActive(user)}>
                  {user.active ? 'Désactiver' : 'Réactiver'}
                </Button>
                <Button variant="secondary" onClick={() => setEnrollingFor(user.id)}>
                  Enrôler un visage
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Débloquer un identifiant">
        <form onSubmit={unlock} className="flex items-end gap-2">
          <div className="flex-1">
            <Field
              id="unlock-identifier"
              label="Identifiant bloqué"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={unlocking || !identifier.trim()}>
            {unlocking ? 'Un instant…' : 'Débloquer'}
          </Button>
        </form>
        {unlockMessage && <p className="mt-2 text-sm text-slate-600">{unlockMessage}</p>}
      </Card>

      {enrollingFor && (
        <FaceCaptureModal
          onCapture={(blob) => void enroll(enrollingFor, blob)}
          onCancel={() => setEnrollingFor(null)}
        />
      )}
    </>
  );
}
