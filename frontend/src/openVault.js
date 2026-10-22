// Open a vault note or folder in NEURO's own Vault view, from anywhere (22 Oct 2026).
//
// Task context shows notes deep inside task cards that are not handed App's
// navigation. App registers the one opener on mount; until it has, opening is a
// no-op rather than a crash.
let _open = null;

export function registerVaultOpener(fn) { _open = typeof fn === 'function' ? fn : null; }

/** `item` is a task-context item ({ open: { kind, path } }) or a path string. */
export function openInVault(item) {
  const p = typeof item === 'string' ? item : item && ((item.open && item.open.path) || item.ref);
  if (_open && p) _open(p);
}
