# Hydra VJ

A live visual performance app built on [Hydra](https://github.com/ojack/hydra), Olivia Jack's open-source video synth.

50+ hand-coded presets, audio reactivity, projection mapping, cellular automata, and optional [Daydream Scope](https://daydream.live/) integration for real-time AI video generation.

Forked from [hydra-synth](https://github.com/hydra-synth/hydra-synth). Licensed under AGPL-3.0.

## What's in this repo

- `dist/launcher.html` - Main launcher UI (presets, controls, audio meter, Scope bridge)
- `dist/output.html` - Fullscreen output window
- `presets/` - 50+ Hydra presets (`.md` files with executable code blocks)
- `server.cjs` - Local server with WebSocket sync, Ableton Link, OSC bridge
- `scope-presets.json` - Daydream Scope preset configurations
- `src/` - Modified hydra-synth engine
- `dist/hydra-synth.js` - Bundled engine

## Quick start

```bash
npm install
node server.cjs
```

Open `http://localhost:8000` in your browser. The launcher opens the output window automatically.

## Features

**Hydra engine** - Live-coded GLSL shaders via Hydra's JavaScript API. All presets are audio-reactive with smoothed envelopes.

**Preset system** - Presets load from `presets/*.md`. Each file contains a code block that executes directly in the Hydra context. Global controls (brightness, contrast, saturation, hue, blur) apply across all presets.

**Audio reactivity** - Microphone input with FFT analysis. Bass, mid, treble, and overall level are available as smoothed globals (`a.fft[0]` through `a.fft[3]`).

**Daydream Scope** - Optional AI video generation via Scope's Remote Inference. Connect with one toggle. Parameters (noise, VACE strength, denoising steps, prompts) can be sequenced via Ableton Link on bar boundaries.

**Cellular automata** - Lenia, SmoothLife, MNCA, Orbium, and more, built in as content sources.

**Projection mapping** - Warp mesh editor for mapping output onto surfaces.

## Scope setup

1. Get a [Daydream Scope](https://daydream.live/) account
2. Create `daydream.config.json` with your API key:
   ```json
   { "apiKey": "your-key-here" }
   ```
3. Toggle Scope on in the launcher

## LoRA

I trained a custom Wan 2.1 14B LoRA on my Hydra output for use with Scope. Trigger word: `hydravj`

[hydravj LoRA on HuggingFace](https://huggingface.co/diegochavez/hydra_wan_2-1_14B)

## Links

- [Hydra](https://hydra.ojack.xyz/) - Olivia Jack's original project
- [Daydream Scope](https://daydream.live/) - Real-time AI video
- [ai-toolkit](https://github.com/ostris/ai-toolkit) - LoRA training
