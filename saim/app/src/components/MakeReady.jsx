import { useState } from 'react';
import { makeItReady } from '../makeReady.mjs';

// The "Make this ready" control on a Now row. Rendered ONLY for a row the
// server said SAiM can take forward (`item` from GET /eligible); a row without
// one renders nothing. It sits AFTER the row's own action, so a meeting's own
// controls stay first. On the kiosk the shell passes `readOnly` and nothing is
// drawn. After a press it says what SAiM made, and where to see it.

/** PURE view. */
export function MakeReadyView({ item, result = null, busy = false, readOnly = false, onPress, onOpen }) {
  if (!item || readOnly) return null;
  if (result) {
    return (
      <div className="mr" role="status">
        <p className="mr__say">{result.kind === 'prepared' ? result.headline : result.message}</p>
        {result.kind === 'prepared' && onOpen && <button type="button" className="mr__btn" onClick={onOpen}>See it on the SAiM home →</button>}
      </div>
    );
  }
  if (item.prepared) {
    return <div className="mr">{onOpen && <button type="button" className="mr__btn" onClick={onOpen}>See what SAiM prepared →</button>}</div>;
  }
  return (
    <div className="mr">
      <button type="button" className="mr__btn mr__btn--go" onClick={onPress} disabled={busy}>{busy ? 'Making it ready…' : item.label || 'Make this ready'}</button>
    </div>
  );
}

export default function MakeReady({ item, call, readOnly = false, onNavigate = null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const press = async () => { setBusy(true); try { setResult(await makeItReady(call, item)); } finally { setBusy(false); } };
  return <MakeReadyView item={item} result={result} busy={busy} readOnly={readOnly} onPress={press} onOpen={onNavigate ? () => onNavigate('surface') : null} />;
}
