import React, { useRef, useState } from 'react';
import './AttachmentPicker.css';

/**
 * Attach files to an email Nick is writing (16 Oct 2026). Used by the Inbox
 * reply (EmailCard) and Personal inbox → Compose.
 *
 * Files are read in the browser and sent with the draft as base64; the server
 * stores them and binds their hashes into the approval, so what is attached
 * when he presses Send is exactly what goes. The limits here mirror the
 * server's (mail-attachments.js) only to say so early — the server decides.
 */
export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function sizeLabel(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** files: [{ name, contentType, size, dataBase64 }] — exactly what the prepare routes take (size is display only). */
export default function AttachmentPicker({ files, onChange, disabled = false }) {
  const input = useRef(null);
  const [error, setError] = useState('');
  const total = files.reduce((n, f) => n + (f.size || 0), 0);

  const add = async (list) => {
    setError('');
    const picked = Array.from(list || []);
    if (!picked.length) return;
    if (files.length + picked.length > MAX_FILES) { setError(`At most ${MAX_FILES} files.`); return; }
    const adding = picked.reduce((n, f) => n + f.size, 0);
    if (total + adding > MAX_TOTAL_BYTES) { setError(`Attachments can total at most ${sizeLabel(MAX_TOTAL_BYTES)} — that would be ${sizeLabel(total + adding)}.`); return; }
    try {
      const read = await Promise.all(picked.map(async (f) => ({ name: f.name, contentType: f.type || 'application/octet-stream', size: f.size, dataBase64: await readFile(f) })));
      onChange([...files, ...read]);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="att-picker" data-testid="attachment-picker"
      onDragOver={(e) => { if (!disabled) e.preventDefault(); }}
      onDrop={(e) => { if (disabled) return; e.preventDefault(); add(e.dataTransfer.files); }}>
      <input ref={input} type="file" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <button type="button" className="att-add" disabled={disabled} onClick={() => input.current && input.current.click()}>📎 Attach files</button>
      {files.length > 0 && <span className="att-total">{files.length} file{files.length === 1 ? '' : 's'} · {sizeLabel(total)}</span>}
      {files.length > 0 && (
        <ul className="att-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="att-item">
              <span className="att-name" title={f.name}>{f.name}</span>
              <span className="att-size">{sizeLabel(f.size)}</span>
              {!disabled && <button type="button" className="att-remove" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>✕</button>}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="att-error">{error}</div>}
    </div>
  );
}

/** The approval card's read-only list of what a prepared email carries. */
export function AttachmentList({ attachments }) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  return (
    <ul className="att-list att-list-readonly" data-testid="attachment-list">
      {attachments.map((f) => (
        <li key={f.sha256 || f.name} className="att-item">
          <span className="att-name" title={f.name}>📎 {f.name}</span>
          <span className="att-size">{sizeLabel(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}
