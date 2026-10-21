import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/** Charge des données au montage de la page, avec chargement, erreur et rechargement manuel. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Erreur inattendue'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
