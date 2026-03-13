# Cohesive Flock + Rainbow Aberration Trail

```javascript
// 🕊️ Cohesive Flock + Rainbow Aberration Trail (colored)

// ---- audio (very gentle) ----
a.setBins(4);
a.setSmooth(0.9);
const low  = () => a.fft[0];
const mid  = () => a.fft[2];
const amp  = () => (low()+mid())*0.5;

// ---- flock params ----
const DEPTH = 3;
const COLS  = 22;
const EDGE  = 0.019;
const ROUND = 0.006;
const ROT_S = 0.1;
const FLOW  = 0.3;

const bird = () => shape(200, EDGE, ROUND);

// small helper: soft pastel RGB generator (based on index/time/depth)
function birdColor(i, d){
  // base hue sweep across columns, mapped into R/G/B oscillators for soft pastels
  const huePhase = i * 0.16 + time * 0.05 + d * 0.6;
  const r = 0.85 + 0.15 * Math.sin(huePhase + 0.0) * (1 - d*0.7) + amp()*0.001;
  const g = 0.85 + 0.14 * Math.sin(huePhase + 2.0) * (1 - d*0.6) + low()*0.001;
  const b = 0.85 + 0.13 * Math.sin(huePhase + 4.0) * (1 - d*0.5) + mid()*0.001;
  // clamp-ish by returning the three values
  return [r, g, b];
}

// flow fields (tiny, slow)
const flowX = (i,d) => Math.sin(time*0.12 + i*0.6) * FLOW*(1-d) * (1 + low()*0.2);
const flowY = (i,d) => Math.cos(time*0.10 + i*0.7) * (FLOW*0.8)*(1-d) * (1 + mid()*0.2);

// build a layer of birds (returns a Hydra src)
function flockLayer(i){
  const d = i / (DEPTH-1);
  // column count per layer (fewer deeper)
  const cols = Math.max(4, Math.floor(COLS - i * 2));
  // build base repeated birds
  let layer = bird()
    .repeat(cols, 8)                                      // columns x rows (rows fixed for stability)
    .scale(() => 1 - d*0.15 + Math.sin(time*0.5 + i)*0.02 + amp()*0.02)
    .rotate(() => time*ROT_S * (1 + d*0.15) + Math.sin(time*0.07 + i)*0.02)
    .scrollX(() => flowX(i,d))
    .scrollY(() => flowY(i,d))
    .modulate(noise(0.9 - d*0.3, 0.02 + d*0.05), 0.08 + d*0.12)
    .brightness(0.018 + d*0.005);

  // apply soft per-column color by modulating hue across the repeated grid
  // We emulate column-based tint by layering a very subtle color overlay that shifts with time
  const colTint = () => {
    const idx = i; // layer index as seed
    const c = birdColor(idx, d);
    // small extra audio responsiveness to tint
    const gain = 0.08 + amp()*0.08;
    return [c[0] + gain*low(), c[1] + gain*mid(), c[2] + gain*0.5];
  };

  return layer.color(() => {
    const cc = colTint();
    return cc[0]; // r
  }, () => {
    const cc = colTint();
    return cc[1]; // g
  }, () => {
    const cc = colTint();
    return cc[2]; // b
  });
}

// render layers to internal buffers
flockLayer(0).out(o1);
flockLayer(1).out(o2);
flockLayer(2).out(o3);

// composite: keep contrast gentle so the colors read as pastel
const baseComp = () => src(o1)
  .add(src(o2), 0.85)
  .add(src(o3), 0.6)
  .contrast(1.01)
  .saturate(1.02);

// draw once into o0
baseComp().out(o0);

// ---- chromatic aberration rainbow tracer ----
const aberr = () => src(o0)
  // Red channel slightly right/down
  .r()
    .scrollX( 0.002 + low()*0.0012 )
    .scrollY( 0.0012 + mid()*0.0008 )
    .color(1,0.2,0.2)
  // add Green slightly left/up
  .add(
    src(o0).g()
      .scrollX( -(0.0016 + low()*0.0008) )
      .scrollY( -(0.0011 + mid()*0.0007) )
      .color(0.9,1.1,1.4)
  )
  // add Blue slightly vertical
  .add(
    src(o0).b()
      .scrollY( 0.0017 + amp()*0.0009 )
      .color(0.2,0.5,0.3)
  )
  .saturate(1.09)
  .colorama(0.002 + amp()*0.004);

// ---- gentle feedback trail ----
const trail = () => src(o0)
  .blend(baseComp(), 0.51 + amp()*0.25)
  .modulateScale(noise(1.6, 0.03), 0.003 + amp()*0.0008)
  .modulateRotate(noise(1.2, 0.02), 0.002)
  .luma(0.005, 0.08)
  .brightness(0.027);

// final composite: colored flock + rainbow edges + restrained trail
aberr()
  .blend(trail(), 0.69)
  .contrast(1.042)
  .saturate(1.59)
  .out();
```
