#!/usr/bin/env python3
"""Scope Syphon → MJPEG bridge for browser consumption.
Captures Scope's Syphon output and serves it as an MJPEG stream
that any browser can display as an <img> or video source.

Usage: python3 scope-video-bridge.py [port]
Default port: 8001
"""

import sys
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import io

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8001

# Try to import syphon
try:
    import syphon
    from syphon.utils.numpy import copy_mtl_texture_to_image
    HAS_SYPHON = True
except ImportError:
    HAS_SYPHON = False
    print("syphon-python not available — install with: pip install syphon-python")

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("Pillow not available — install with: pip install Pillow")

# Global frame buffer
current_frame = None
frame_lock = threading.Lock()


def syphon_capture_loop():
    """Background thread that captures Syphon frames."""
    global current_frame
    if not HAS_SYPHON or not HAS_PIL:
        return

    print(f"Looking for Syphon server 'Scope'...")
    client = None

    while True:
        try:
            if client is None:
                # Find the Scope syphon server
                servers = syphon.SyphonServerDirectory()
                time.sleep(1)
                found = None
                for s in servers.servers:
                    name = s.get('SyphonServerDescriptionNameKey', '')
                    app = s.get('SyphonServerDescriptionAppNameKey', '')
                    if 'Scope' in name or 'scope' in name:
                        found = s
                        break
                if found:
                    client = syphon.SyphonMetalClient(found)
                    print(f"Connected to Syphon: {found}")
                else:
                    time.sleep(2)
                    continue

            # Get frame
            tex = client.new_frame_image
            if tex is not None:
                img_array = copy_mtl_texture_to_image(tex)
                img = Image.fromarray(img_array[:, :, :3])  # Drop alpha
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=75)
                with frame_lock:
                    current_frame = buf.getvalue()

            time.sleep(1.0 / 15)  # ~15 fps

        except Exception as e:
            print(f"Syphon error: {e}")
            client = None
            time.sleep(2)


class MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()

            try:
                while True:
                    with frame_lock:
                        frame = current_frame
                    if frame:
                        self.wfile.write(b'--frame\r\n')
                        self.wfile.write(b'Content-Type: image/jpeg\r\n')
                        self.wfile.write(f'Content-Length: {len(frame)}\r\n'.encode())
                        self.wfile.write(b'\r\n')
                        self.wfile.write(frame)
                        self.wfile.write(b'\r\n')
                    time.sleep(1.0 / 15)
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif self.path == '/frame':
            with frame_lock:
                frame = current_frame
            if frame:
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Content-Length', str(len(frame)))
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_response(503)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(b'No frame available')

        elif self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            has_frame = current_frame is not None
            self.wfile.write(f'{{"ok":true,"has_frame":{str(has_frame).lower()}}}'.encode())

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress request logs


if __name__ == '__main__':
    if HAS_SYPHON and HAS_PIL:
        t = threading.Thread(target=syphon_capture_loop, daemon=True)
        t.start()

    print(f"MJPEG bridge on http://localhost:{PORT}/stream")
    print(f"Single frame: http://localhost:{PORT}/frame")
    HTTPServer(('0.0.0.0', PORT), MJPEGHandler).serve_forever()
