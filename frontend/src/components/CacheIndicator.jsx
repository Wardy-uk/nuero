import React from 'react';
import './CacheIndicator.css';

function formatAge(ms) {
  if (!ms) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/**
 * Small pill showing data freshness.
 * Hidden when status is "live".
 *
 * @param {{ status: "live"|"cached"|"unavailable", cacheAge: number|null }} props
 */
export default function CacheIndicator({ status, cacheAge }) {
  if (status === 'live') return null;

  const isCached = status === 'cached';

  return (
    <span className={`cache-indicator ${isCached ? 'cached' : 'offline'}`}>
      <span className={`cache-dot ${isCached ? 'warn' : 'danger'}`} />
      {isCached ? `Cached · ${formatAge(cacheAge)}` : 'Offline'}
    </span>
  );
}
