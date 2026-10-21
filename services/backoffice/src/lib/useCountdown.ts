import { useEffect, useRef, useState } from 'react';

/**
 * Décompte en secondes, pour afficher « réessayez dans X s ». `onExpire` est appelé par le
 * minuteur lui-même à la fin du décompte, jamais par une comparaison faite ailleurs dans le rendu :
 * ça évite de lire une valeur restante pas encore initialisée et de déclencher la fin trop tôt.
 */
export function useCountdown(seconds: number | null, onExpire?: () => void): number {
  const [remaining, setRemaining] = useState(seconds ?? 0);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!seconds) {
      setRemaining(0);
      return;
    }
    setRemaining(seconds);
    const interval = setInterval(() => {
      setRemaining((r) => {
        if (r > 1) return r - 1;
        clearInterval(interval);
        onExpireRef.current?.();
        return 0;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);

  return remaining;
}
