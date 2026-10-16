#!/usr/bin/env python3
"""Local-only preview with exact allowlisted Mac and Windows downloads."""
import argparse
import hashlib
import json
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent

def packages():
    package = json.loads((ROOT / 'app/package.json').read_text())
    version = package['version']
    filename = f'CanvasManager-{version}-mac-arm64.dmg'
    mac = {'version': version, 'tag': f'v{version}', 'filename': filename}
    windows = json.loads((SITE / 'windows-release.json').read_text())
    result = {'mac': mac, 'windows': windows}
    for platform, package in result.items():
        artifact = ROOT / 'app/dist' / package['filename']
        package.update(available=False, url='/downloads/' + package['filename'])
        if artifact.is_file():
            stat = artifact.stat()
            sha256 = checksum(str(artifact), stat.st_mtime_ns, stat.st_size)
            if platform == 'mac' or (stat.st_size == package['size'] and sha256 == package['sha256']):
                package.update(available=True, size=stat.st_size, sha256=sha256)
        if platform == 'mac' and not package['available']:
            package.update(size=0, sha256=None)
    return result

@lru_cache(maxsize=4)
def checksum(path, mtime, size):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        super().end_headers()

    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def serve(self, head_only):
        route = unquote(urlsplit(self.path).path)
        releases = packages()
        if route in ('/api/release', '/release.json'):
            payload = {**releases['mac'], 'schemaVersion': 2, 'packages': releases}
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if not head_only:
                self.wfile.write(data)
            return
        if route.startswith('/downloads/'):
            selected = next(((platform, package) for platform, package in releases.items()
                             if route == package['url'] and package['available']), None)
            if selected is None:
                self.send_error(404, 'Package not available')
                return
            platform, metadata = selected
            filename = metadata['filename']
            package = ROOT / 'app/dist' / filename
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-apple-diskimage' if platform == 'mac'
                             else 'application/vnd.microsoft.portable-executable')
            self.send_header('Content-Length', str(package.stat().st_size))
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.end_headers()
            if not head_only:
                try:
                    with package.open('rb') as stream:
                        self.copyfile(stream, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        candidate = (SITE / route.lstrip('/')).resolve()
        if not candidate.is_relative_to(SITE) or any(part.startswith('.') for part in Path(route).parts):
            self.send_error(404)
            return
        if candidate.is_dir() and not (candidate / 'index.html').is_file():
            self.send_error(404)
            return
        super().do_HEAD() if head_only else super().do_GET()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    print(f'Canvas 本地官网：http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
