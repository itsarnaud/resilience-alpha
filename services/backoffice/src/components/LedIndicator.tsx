export type LedState = 'off' | 'green-blink' | 'green-solid' | 'red-blink' | 'red-solid';

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

export default function LedIndicator({ state }: { state: LedState }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-700">
      <span className={`h-3 w-3 rounded-full ${DOT[state]}`} aria-hidden />
      LED : {LABEL[state]}
    </span>
  );
}
