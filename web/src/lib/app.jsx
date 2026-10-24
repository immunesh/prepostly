import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { get, patch, setBrandId } from './api.js';

// Session, active brand and product catalogue, shared across the app.

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function AppProvider({ children }) {
  const [me, setMe] = useState(undefined);
  const [catalog, setCatalog] = useState(null);
  const [toasts, setToasts] = useState([]);

  const meRef = useRef(undefined);
  const refresh = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const m = await get('/api/me');
        setBrandId(m?.brand?.id || null);
        meRef.current = m;
        setMe(m);
        return m;
      } catch (e) {
        // Only the server signs you out: /api/me answers null when signed out and 401/403 when
        // the session is gone or suspended. A dropped connection, a laptop waking up, a deploy
        // restart or a proxy error keeps the current session and retries.
        if (e.status === 401 || e.status === 403) {
          setBrandId(null);
          meRef.current = null;
          setMe(null);
          return null;
        }
        if (attempt >= 2) {
          if (meRef.current === undefined) setMe(null);
          return meRef.current ?? null;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    get('/api/catalog').then(setCatalog).catch(() => {});
  }, [refresh]);

  const toast = useCallback((message, kind = '') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const switchBrand = useCallback(async (id) => {
    await patch('/api/me', { current_brand_id: id });
    await refresh();
  }, [refresh]);

  const can = (min) => {
    const rank = { reviewer: 1, editor: 2, admin: 3, owner: 4 };
    return (rank[me?.brand?.role] || 0) >= rank[min];
  };

  return (
    <AppContext.Provider value={{ me, refresh, catalog, toast, switchBrand, brand: me?.brand, can }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </AppContext.Provider>
  );
}

/** Load data with loading/error state; returns [data, { loading, error, reload, setData }]. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({ data: null, loading: false, error: e });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return [state.data, { loading: state.loading, error: state.error, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) }];
}
