let overridePin = null;

function getPin(env = process.env) {
  return overridePin || String(env.NEURO_PIN || '');
}

function setPin(pin) {
  overridePin = String(pin || '').trim() || null;
}

function clearPin() {
  overridePin = null;
}

function hasOverride() {
  return Boolean(overridePin);
}

module.exports = { getPin, setPin, clearPin, hasOverride };
