import { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from './api';
import { cachePut, cacheGet } from './cacheStore';

/**
 * Hook that fetches a GET endpoint with IndexedDB caching fallback.
 *
 * @param {string} path       — API path, e.g. "/api/todos"
 * @param {object} [opts]
 * @param {number|null} opts.interval  — polling interval in ms (null = no polling)
 * @param {function|null} opts.transform — optional (jsonBody) => value
 * @returns {{ data: *, status: "live"|"cached"|"unavailable", error: string|null, refresh: () => void, cacheAge: number|null }}
 */
export default function useCachedFetch(path, opts = {}) {
  const { interval = null, transform = null } = opts;
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('unavailable'); // live | cached | unavailable
  const [error, setError] = useState(null);
  const [cacheAge, setCacheAge] = useState(null); // ms since cache was written
  const mountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const value = transform ? transform(json) : json;

      if (mountedRef.current) {
        setData(value);
        setStatus('live');
        setError(null);
        setCacheAge(null);
      }

      // Write to cache in background
      cachePut(path, json);
    } catch (e) {
      // Fetch failed — try cache
      const cached = await cacheGet(path);
      if (mountedRef.current) {
        if (cached) {
          const value = transform ? transform(cached.data) : cached.data;
          setData(value);
          setStatus('cached');
          setCacheAge(Date.now() - cached.ts);
          setError(null);
        } else {
          setStatus('unavailable');
          setError(e.message);
        }
      }
    }
  }, [path, transform]);

  // Initial fetch + polling
  useEffect(() => {
    mountedRef.current = true;
    doFetch();

    let timer;
    if (interval) {
      timer = setInterval(doFetch, interval);
    }

    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [doFetch, interval]);

  return { data, status, error, cacheAge, refresh: doFetch };
}
