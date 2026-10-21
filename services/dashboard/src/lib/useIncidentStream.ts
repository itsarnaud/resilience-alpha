import { useEffect, useRef, useState } from 'react';
import type { Incident } from './api';
import { parseSse } from './sse';
import { session } from './session';

export interface IncidentStream {
  incidents: Incident[];
  /** `false` tant que l'instantané initial n'est pas arrivé, ou après une coupure. */
  connected: boolean;
}

const byDetectedAtDesc = (a: Incident, b: Incident) => b.detected_at.localeCompare(a.detected_at);

function upsert(list: Incident[], incident: Incident): Incident[] {
  const next = list.some((i) => i.id === incident.id)
    ? list.map((i) => (i.id === incident.id ? incident : i))
    : [...list, incident];
  return next.sort(byDetectedAtDesc);
}

/**
 * Flux temps réel des incidents. Reconnecte automatiquement si la connexion tombe (réseau, service
 * redémarré), avec un délai croissant pour ne pas marteler le serveur.
 */
export function useIncidentStream(): IncidentStream {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [connected, setConnected] = useState(false);
  // Évite de notifier après un démontage ou un changement de session (fuite de mémoire, course).
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    let attempt = 0;

    async function run() {
      while (live.current) {
        const token = session.get()?.token;
        if (!token) return;
        try {
          const res = await fetch('/remediation/v1/incidents/stream', {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (res.status === 401) {
            session.clear();
            return;
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

          attempt = 0;
          for await (const { event, data } of parseSse(res.body)) {
            if (!live.current) return;
            if (event === 'snapshot') {
              setIncidents([...(data as Incident[])].sort(byDetectedAtDesc));
              setConnected(true);
            } else if (event === 'incident') {
              setIncidents((list) => upsert(list, data as Incident));
            }
          }
        } catch {
          // coupure réseau, ou le flux s'est arrêté : on retente ci-dessous
        }
        if (!live.current) return;
        setConnected(false);
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
      }
    }

    void run();
    return () => {
      live.current = false;
      controller.abort();
    };
  }, []);

  return { incidents, connected };
}
