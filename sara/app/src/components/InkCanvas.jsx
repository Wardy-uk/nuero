import { useEffect, useRef, useState } from 'react';
import { transcribeHandwriting } from '../api';
import './InkCanvas.css';

// Ink surface for iPad Pencil (and mouse/touch). White "paper" + black ink so the
// brain's vision OCR reads it cleanly. On Convert, exports a PNG and asks the brain
// to transcribe → returns text to the parent (which drops it into the note composer).
export default function InkCanvas({ onText, onCancel }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const usedPen = useRef(false); // once a Pencil is seen, reject touch (palm rejection)
  const hasInk = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Size the canvas backing store to its CSS box × devicePixelRatio for crisp ink.
  useEffect(() => {
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  function point(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e) {
    if (e.pointerType === 'pen') usedPen.current = true;
    if (usedPen.current && e.pointerType === 'touch') return; // palm rejection
    e.preventDefault();
    drawing.current = true;
    last.current = point(e);
    canvasRef.current.setPointerCapture(e.pointerId);
  }

  function move(e) {
    if (!drawing.current) return;
    if (usedPen.current && e.pointerType === 'touch') return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    hasInk.current = true;
  }

  function up() { drawing.current = false; last.current = null; }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    hasInk.current = false;
    setError(null);
  }

  async function convert() {
    if (!hasInk.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise((resolve) => canvasRef.current.toBlob(resolve, 'image/png'));
      const text = await transcribeHandwriting(blob);
      if (!text.trim()) { setError('Nothing transcribed — try writing more clearly.'); return; }
      onText(text.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ink">
      <div className="ink__bar">
        <span className="ink__hint">Write with your Pencil</span>
        <div className="ink__actions">
          <button type="button" className="ink__btn" onClick={clear} disabled={busy}>Clear</button>
          <button type="button" className="ink__btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="ink__btn ink__btn--go" onClick={convert} disabled={busy}>
            {busy ? 'Reading…' : 'Convert to text'}
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="ink__canvas"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        onPointerCancel={up}
      />
      {error && <div className="ink__error err">{error}</div>}
    </div>
  );
}
