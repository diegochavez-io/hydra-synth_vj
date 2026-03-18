#!/usr/bin/env python3
"""
CA WebSocket frame server for Hydra.

Streams JPEG frames over WebSocket at 30fps.
JS client uses createImageBitmap (GPU decode) for smooth display.

Usage:  python dist/ca-server.py [preset] [--size N] [--fps N] [--port N]
Hydra:  caStream('reef').out(o0)
"""

import sys, os, time, io, asyncio, json, threading

for p in ['/Users/agi/Code/daydream_scope',
          os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'daydream_scope')]:
    if os.path.isdir(p): sys.path.insert(0, p); break

from plugins.cellular_automata.simulator import CASimulator
from plugins.cellular_automata.presets import PRESET_ORDER
from PIL import Image
import websockets


class CARunner:
    """Runs CA sim in background thread, latest JPEG always available."""

    def __init__(self, preset='reef', sim_size=512, target_fps=30):
        self.sim_size = sim_size
        self.target_fps = target_fps
        self.preset = preset
        self.dt = 1.0 / target_fps
        self._frame = None
        self._lock = threading.Lock()
        self._running = True
        self._switching = False

        self.sim = CASimulator(preset_key=preset, sim_size=sim_size)
        print(f"  Warming up {preset}...")
        self.sim.run_warmup()
        print(f"  Ready")

        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while self._running:
            if self._switching:
                time.sleep(0.05)
                continue  # keep last frame available while switching
            t0 = time.monotonic()
            try:
                rgb = self.sim.step(self.dt)
                img = Image.fromarray(rgb)
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=85)
                with self._lock:
                    self._frame = buf.getvalue()
            except Exception as e:
                print(f"  Sim error: {e}")
            elapsed = time.monotonic() - t0
            if elapsed < self.dt:
                time.sleep(self.dt - elapsed)

    def get_frame(self):
        with self._lock:
            return self._frame

    def set_preset(self, key):
        if key not in PRESET_ORDER:
            return False
        if key == self.preset:
            return True  # already on this preset, skip warmup
        self._switching = True
        try:
            self.sim = CASimulator(preset_key=key, sim_size=self.sim_size)
            self.sim.run_warmup()
            self.preset = key
        finally:
            self._switching = False
        return True

    def reseed(self):
        try:
            from plugins.cellular_automata.presets import get_preset
            p = get_preset(self.preset)
            self.sim.engine.seed(p.get("seed", "center") if p else "center")
        except Exception:
            self.sim.engine.seed("center")


runner = None


async def ws_handler(websocket):
    print("  Client connected")

    async def send_frames():
        while True:
            frame = runner.get_frame()
            if frame:
                try:
                    await websocket.send(frame)
                except websockets.exceptions.ConnectionClosed:
                    break
            await asyncio.sleep(1.0 / runner.target_fps)

    async def recv_commands():
        try:
            async for msg in websocket:
                try:
                    cmd = json.loads(msg)
                    if cmd.get('type') == 'preset':
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(None, runner.set_preset, cmd['value'])
                        await websocket.send(json.dumps({'type': 'preset', 'value': runner.preset}))
                    elif cmd.get('type') == 'reseed':
                        runner.reseed()
                    elif cmd.get('type') == 'params':
                        runner.sim.set_runtime_params(**cmd.get('value', {}))
                    elif cmd.get('type') == 'engine_params':
                        runner.sim.engine.set_params(**cmd.get('value', {}))
                    elif cmd.get('type') == 'presets':
                        await websocket.send(json.dumps({'type': 'presets', 'value': PRESET_ORDER}))
                except Exception as e:
                    print(f"  Cmd error: {e}")
        except websockets.exceptions.ConnectionClosed:
            pass

    try:
        await asyncio.gather(send_frames(), recv_commands())
    except Exception:
        pass
    print("  Client disconnected")


def main():
    global runner
    preset = 'reef'
    sim_size = 512
    fps = 30
    port = 9737

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '--size' and i + 1 < len(args):
            sim_size = int(args[i + 1]); i += 2
        elif args[i] == '--fps' and i + 1 < len(args):
            fps = int(args[i + 1]); i += 2
        elif args[i] == '--port' and i + 1 < len(args):
            port = int(args[i + 1]); i += 2
        elif args[i] in PRESET_ORDER:
            preset = args[i]; i += 1
        else:
            print(f"Unknown: {args[i]}"); return

    print(f"CA WebSocket Server")
    print(f"  Preset: {preset}  Sim: {sim_size}x{sim_size}  FPS: {fps}")

    runner = CARunner(preset=preset, sim_size=sim_size, target_fps=fps)

    print(f"\n  ws://localhost:{port}")
    print(f"\n  Hydra: caStream('{preset}').out(o0)\n")

    async def serve():
        async with websockets.serve(ws_handler, "0.0.0.0", port,
                                     max_size=2**22, ping_interval=None):
            await asyncio.Future()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        runner._running = False
        print("\nStopped.")


if __name__ == '__main__':
    main()
