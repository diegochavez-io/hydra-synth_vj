// ===== HYDRA AUDIO BOOTSTRAP =====
// Auto-injected before every preset. Provides named frequency bands
// and reactive helper functions. Presets can override any setting.
//
// BANDS (all return 0-1 normalized values):
//   kick()      — sub-bass / kick drum energy
//   bass()      — low-end warmth
//   mid()       — vocals / instruments
//   high()      — hi-hats / presence
//   air()       — top-end sizzle / brilliance
//   amp()       — overall level (average of all bands)
//
// HELPERS:
//   pulse(band, threshold)  — returns 1 when band > threshold, else 0 (gate)
//   env(band, attack, release) — smoothed envelope follower
//   scale(band, lo, hi)     — map band 0-1 to custom range
//   beat()                  — 1 on detected beat, else 0
//
// SETTINGS (change these at top of your preset to customize):
//   AUDIO.bins     = 6        — number of FFT bins (4-16)
//   AUDIO.smooth   = 0.85     — smoothing (0=raw, 1=frozen)
//   AUDIO.cutoff   = 2        — noise floor threshold
//   AUDIO.gain     = 10       — overall sensitivity
//   AUDIO.show()              — show FFT visualizer
//   AUDIO.hide()              — hide FFT visualizer

var AUDIO = {
  bins: 6,
  smooth: 0.85,
  cutoff: 2,
  gain: 10,
  _envelopes: {},
  show: function() { a.show() },
  hide: function() { a.hide() },
  apply: function() {
    a.setBins(AUDIO.bins);
    a.setSmooth(AUDIO.smooth);
    a.setCutoff(AUDIO.cutoff);
    a.setScale(AUDIO.gain);
  }
};

AUDIO.apply();

// --- named bands (mapped across the bins) ---
var kick = function() { return a.fft[0] || 0 };
var bass = function() { return a.fft[Math.min(1, a.fft.length - 1)] || 0 };
var mid  = function() { return a.fft[Math.min(2, a.fft.length - 1)] || 0 };
var high = function() { return a.fft[Math.min(Math.floor(a.fft.length * 0.7), a.fft.length - 1)] || 0 };
var air  = function() { return a.fft[a.fft.length - 1] || 0 };
var amp  = function() {
  var sum = 0;
  for (var i = 0; i < a.fft.length; i++) sum += a.fft[i];
  return a.fft.length > 0 ? sum / a.fft.length : 0;
};

// --- helpers ---
// gate: returns 1 when band exceeds threshold, 0 otherwise
var pulse = function(bandFn, threshold) {
  threshold = threshold || 0.5;
  return function() { return bandFn() > threshold ? 1 : 0 };
};

// envelope follower: smoothly tracks a band with attack/release
var env = function(bandFn, attack, release) {
  attack = attack || 0.3;
  release = release || 0.05;
  var key = '_env_' + Math.random().toString(36).slice(2, 8);
  AUDIO._envelopes[key] = 0;
  return function() {
    var val = bandFn();
    var prev = AUDIO._envelopes[key];
    if (val > prev) {
      AUDIO._envelopes[key] = prev + (val - prev) * attack;
    } else {
      AUDIO._envelopes[key] = prev + (val - prev) * release;
    }
    return AUDIO._envelopes[key];
  };
};

// map band value from 0-1 to lo-hi range
var scale = function(bandFn, lo, hi) {
  return function() { return lo + bandFn() * (hi - lo) };
};

// beat detection (uses hydra's built-in)
var beat = function() {
  return a.beat && a.beat._framesSinceBeat < 3 ? 1 : 0;
};

// --- legacy aliases (so existing presets still work) ---
var low = kick;
