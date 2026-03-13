# NDI Setup (Single-Window Control + OBS NDI)

This flow keeps one operator browser window and toggles OBS NDI output directly from the launcher.

## 1) Start local server

```bash
cd /Users/agi/Code/hydra-synth
python3 -m http.server 8080
```

## 2) Open launcher

- Control UI: `http://localhost:8080/dist/launcher.html`

Buttons used for NDI:
- `NDI Out: Off/On` (toggle OBS NDI output)
- `Shift+Click NDI Out` to set/change the OBS NDI output name

Keyboard shortcut:
- `Cmd/Ctrl+Shift+N` toggles NDI output

## 3) OBS setup (one-time)

1. Install DistroAV / OBS-NDI plugin.
2. Enable OBS WebSocket server:
   - `Tools` -> `WebSocket Server Settings`
   - Keep URL `ws://127.0.0.1:4455`
   - Set password if enabled
3. In OBS, create source for Hydra visual:
   - Recommended: **Window Capture** on the launcher window, cropped to stage canvas area.
4. In OBS:
   - `Tools` -> `DistroAV NDI Output Settings`
   - Enable Main Output
   - Set output name (example: `HydraVJ`)

## 4) Start/stop NDI from launcher

1. Click `NDI Out: Off`
2. If prompted, enter OBS WebSocket URL/password.
3. If prompted, enter the DistroAV output name exactly.
4. Button changes to `NDI Out: On` when active.

TouchDesigner `NDI In TOP` should then see that source name.

## 5) Notes

- This does not require opening a separate NDI browser page.
- NDI transport still runs through OBS (most stable for VJ routing).
- If toggle fails, re-check OBS WebSocket and DistroAV output name.
