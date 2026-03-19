# Scope: Smoke Mirror

```js
// Smoke Mirror — AI feed diffused through deep feedback fog
// s3 = Scope NDI (auto-initialized)

AUDIO.bins = 4; AUDIO.smooth = 0.94; AUDIO.apply();
var _lo = function(){ return a.fft[0] || 0 };
var _mi = function(){ return a.fft[2] || 0 };
var low = env(_lo, 0.5, 0.03);
var mid = env(_mi, 0.4, 0.05);

// AI feed — soft, desaturated
src(s3)
  .saturate(0.7)
  .brightness(-0.05)
  .out(o1);

// feedback accumulator — very long decay
src(o0)
  .scale(1.001)
  .rotate(function(){ return 0.0008 + low() * 0.0002 })
  .saturate(1.19)
  .brightness(0.002)
  .out(o2);

// composite: seed AI into feedback fog
src(o2)
  .blend(src(o1), 0.12)
  .modulate(noise(1.5, 0.015), function(){ return 0.008 + mid() * 0.003 })
  .hue(function(){ return 0.006 * Math.sin(time * 0.015) })
  .luma(0.03, 0.04)
  .contrast(1.015)
  .out(o0);
```

<!-- filters:{"hue":340,"sat":100,"bright":100,"contrast":100,"speed":1} -->
