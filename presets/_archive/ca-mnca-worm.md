# CA: MNCA Worm

```js
caStream('mnca_worm').out(o1)

noise(2, 0.015).rotate(()=>time*0.01)
  .color(0.06, 0.04, 0.09).brightness(-0.02)
  .blend(src(o0).scale(1.01).rotate(0, 0.002).saturate(0.9), 0.86)
  .modulate(noise(1.2, 0.015), 0.005)
  .layer(src(o1).luma(0.06, 0.05))
  .out(o0)
```

<!-- filters:{"hue":82,"sat":243,"bright":89,"contrast":91,"speed":0.4} -->
