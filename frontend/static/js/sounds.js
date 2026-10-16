/**
 * Web Audio synthesized sounds — no mp3 files needed.
 * Every sound is generated in real-time via the browser's audio engine.
 */

let ctx = null;
let masterGain = null;
let enabled = true;

// Load user preference
try {
  const stored = localStorage.getItem("ps_sounds_enabled");
  if (stored !== null) enabled = stored === "true";
} catch {}

function ensureCtx() {
  if (ctx) return ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

// Browsers block audio until first user gesture
export function unlockAudio() {
  const c = ensureCtx();
  if (c && c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

export function isSoundEnabled() { return enabled; }

export function setSoundEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem("ps_sounds_enabled", String(enabled)); } catch {}
}

export function toggleSound() {
  setSoundEnabled(!enabled);
  return enabled;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function tone({ freq = 440, dur = 0.15, type = "sine", vol = 0.4, delay = 0, slideTo = null }) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});

  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.15, vol = 0.3, delay = 0, filterFreq = 1200, filterType = "bandpass" }) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});

  const t0 = c.currentTime + delay;
  const bufSize = Math.floor(c.sampleRate * dur);
  const buffer = c.createBuffer(1, bufSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);

  const src = c.createBufferSource();
  src.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  filter.Q.value = 1;

  const gain = c.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter).connect(gain).connect(masterGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---------------------------------------------------------------------------
// Public sounds
// ---------------------------------------------------------------------------

export const sfx = {
  // UI
  click()       { tone({ freq: 700, dur: 0.04, type: "square", vol: 0.15 }); },
  tap()         { tone({ freq: 520, dur: 0.05, type: "triangle", vol: 0.2 }); },
  error()       { tone({ freq: 220, dur: 0.18, type: "sawtooth", vol: 0.25, slideTo: 160 }); },
  success()     { tone({ freq: 660, dur: 0.08, type: "sine", vol: 0.3 }); tone({ freq: 880, dur: 0.14, type: "sine", vol: 0.3, delay: 0.08 }); },

  // Notifications
  notify()      { tone({ freq: 880, dur: 0.1, type: "sine", vol: 0.3 }); tone({ freq: 1320, dur: 0.18, type: "sine", vol: 0.28, delay: 0.09 }); },
  message()     { tone({ freq: 660, dur: 0.08, type: "triangle", vol: 0.3 }); tone({ freq: 880, dur: 0.12, type: "triangle", vol: 0.28, delay: 0.07 }); },

  // Coins / rewards
  coin()        { tone({ freq: 988, dur: 0.07, type: "square", vol: 0.25 }); tone({ freq: 1319, dur: 0.15, type: "square", vol: 0.22, delay: 0.06 }); },
  levelup()     { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.16, type: "triangle", vol: 0.3, delay: i * 0.09 })); },

  // Dice
  diceRoll()    { noise({ dur: 0.5, vol: 0.25, filterFreq: 1800 }); },
  diceTick()    { tone({ freq: 320 + Math.random() * 200, dur: 0.04, type: "square", vol: 0.15 }); },
  diceLand()    { tone({ freq: 180, dur: 0.12, type: "triangle", vol: 0.4, slideTo: 120 }); noise({ dur: 0.1, vol: 0.2, filterFreq: 800 }); },

  // Ludo
  ludoMove()    { tone({ freq: 620, dur: 0.1, type: "sine", vol: 0.3 }); },
  ludoHome()    { [660, 880, 1100].forEach((f, i) => tone({ freq: f, dur: 0.18, type: "sine", vol: 0.32, delay: i * 0.08 })); },
  ludoCapture() { noise({ dur: 0.25, vol: 0.35, filterFreq: 500, filterType: "lowpass" }); tone({ freq: 220, dur: 0.25, type: "sawtooth", vol: 0.3, slideTo: 120 }); },
  ludoExtraTurn(){ tone({ freq: 880, dur: 0.12, type: "sine", vol: 0.3 }); tone({ freq: 1320, dur: 0.15, type: "sine", vol: 0.28, delay: 0.1 }); },

  // Chess
  chessMove()   { tone({ freq: 400, dur: 0.09, type: "sine", vol: 0.28 }); noise({ dur: 0.06, vol: 0.15, filterFreq: 2000 }); },
  chessCapture(){ noise({ dur: 0.2, vol: 0.3, filterFreq: 700, filterType: "lowpass" }); tone({ freq: 260, dur: 0.15, type: "triangle", vol: 0.35, slideTo: 180 }); },
  chessCheck()  { tone({ freq: 990, dur: 0.14, type: "triangle", vol: 0.35 }); tone({ freq: 990, dur: 0.14, type: "triangle", vol: 0.35, delay: 0.16 }); },
  chessCastle() { tone({ freq: 500, dur: 0.1, type: "sine", vol: 0.3 }); tone({ freq: 700, dur: 0.12, type: "sine", vol: 0.3, delay: 0.08 }); },

  // Match results
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone({ freq: f, dur: 0.28, type: "triangle", vol: 0.35, delay: i * 0.12 })
    );
  },
  lose() {
    [523, 440, 349, 262].forEach((f, i) =>
      tone({ freq: f, dur: 0.32, type: "sine", vol: 0.3, delay: i * 0.14 })
    );
  },
  draw() {
    [523, 494, 523].forEach((f, i) =>
      tone({ freq: f, dur: 0.22, type: "sine", vol: 0.28, delay: i * 0.12 })
    );
  },

  // Premium / money
  purchase()    { [880, 1100, 1320, 1760].forEach((f, i) => tone({ freq: f, dur: 0.15, type: "sine", vol: 0.3, delay: i * 0.07 })); },
};