// Can this runtime take dictation? ONE answer for every screen with a mic.
//
// ⚠ Electron is the exception to "the constructor exists, so it works". Chromium
// inside Electron exposes `webkitSpeechRecognition`, but the recognition itself is
// Google's cloud service, which needs an API key only Google Chrome ships — so in
// the laptop's SARA window the mic rendered, took a tap, and failed with a
// `network` error. A button that answers every press with an error is worse than
// no button, so the desktop shell (which identifies itself as `window.saraNative`)
// gets none, and the screens say why.
//
// Still a CAPABILITY check, not a device check: a browser with working recognition
// gets the mic wherever it is.

export function speechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  if (window.saraNative) return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function noMicReason() {
  if (typeof window === 'undefined') return null;
  if (window.saraNative) return 'The desktop app can’t take dictation — type instead, or use SARA on your phone.';
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    return 'This browser has no speech recognition, so there’s no mic. On iPhone that usually means the installed app rather than Safari.';
  }
  return null;
}
