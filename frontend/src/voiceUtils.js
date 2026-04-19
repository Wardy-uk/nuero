const STORAGE_KEY = 'sara_voice_out';

export function isVoiceOutEnabled() {
  try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
}

export function setVoiceOutEnabled(enabled) {
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch {}
  if (!enabled) window.speechSynthesis?.cancel();
}

// Chrome on Windows lazily loads voices — cache after voiceschanged fires
let cachedVoice = null;
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; };
}

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  cachedVoice = voices.find(v => /google.*uk.*female/i.test(v.name))
    || voices.find(v => /hazel/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /moira|fiona/i.test(v.name) && /en/i.test(v.lang))
    || voices.find(v => /en-GB/i.test(v.lang) && /female/i.test(v.name))
    || voices.find(v => /en-GB/i.test(v.lang))
    || null;
  return cachedVoice;
}

function cleanText(text) {
  return text
    .replace(/\[.*?\]/g, '')
    .replace(/[#*_`>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

export function speakSara(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const clean = cleanText(text);
  if (!clean) return;
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 0.9;
  utterance.pitch = 0.95;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

export function speakIfEnabled(text) {
  if (isVoiceOutEnabled()) speakSara(text);
}
