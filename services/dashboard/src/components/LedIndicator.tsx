import type { LedState } from '../lib/api';

const DOT: Record<LedState, string> = {
  off: 'bg-slate-300',
  'green-blink': 'bg-emerald-500 animate-pulse',
  'green-solid': 'bg-emerald-500',
  'red-blink': 'bg-red-500 animate-pulse',
  'red-solid': 'bg-red-500',
};

const LABEL: Record<LedState, string> = {
  off: 'éteinte',
  'green-blink': 'verte clignotante',
  'green-solid': 'verte fixe',
  'red-blink': 'rouge clignotante',
  'red-solid': 'rouge fixe',
};

/** Reflet de la LED physique de l'ESP8266 : utile pour vérifier à distance (Clip Chrono, jury). */
export default function LedIndicator({ state }: { state: LedState }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-700">
      <span className={`h-3 w-3 rounded-full ${DOT[state]}`} aria-hidden />
      LED : {LABEL[state]}
    </span>
  );
}
