#!/usr/bin/env python
"""在 Windows 上组装 macOS 应用包(交叉打包)。

electron-builder 不允许在 Windows 构建 mac 目标,这里手工组装:
1. 从镜像下载 Electron(darwin-x64)官方 zip
2. 用 asar 打包应用代码(含生产依赖)
3. 用 zipfile 直接改写 zip(不解压,保住 macOS 符号链接),注入 app.asar

用法: python scripts/build-mac.py [版本号,默认读 package.json] [electron版本,默认 43.6.0]
产物: dist/CanvasManager-<ver>-mac-x64.zip
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
import zlib

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VER = sys.argv[1] if len(sys.argv) > 1 else json.load(open(os.path.join(APP_DIR, 'package.json'), encoding='utf-8'))['version']
ARCH = sys.argv[2] if len(sys.argv) > 2 else 'x64'  # x64(Intel,含 MBP2017) 或 arm64(M 系列)
ELECTRON_VER = sys.argv[3] if len(sys.argv) > 3 else '43.6.0'  # 最后支持 macOS 12 的系列
MIRROR = 'https://npmmirror.com/mirrors/electron/'
WORK = os.path.join(APP_DIR, 'dist', f'mac-build-{ARCH}')
OUT = os.path.join(APP_DIR, 'dist', f'CanvasManager-{VER}-mac-{ARCH}.zip')

def run(cmd, cwd=None):
    exe = shutil.which(cmd[0])
    if not exe:
        raise SystemExit(f'找不到命令: {cmd[0]}')
    print('>', ' '.join(cmd[:6]), '...')
    subprocess.run([exe] + cmd[1:], check=True, cwd=cwd)

# 1. 下载 Electron darwin-x64
run(['node', os.path.join(APP_DIR, 'scripts', 'plugin-catalog.cjs'), '--check'], cwd=APP_DIR)
ez = os.path.join(WORK, f'electron-v{ELECTRON_VER}-darwin-{ARCH}.zip')
os.makedirs(WORK, exist_ok=True)
if not os.path.exists(ez):
    url = f'{MIRROR}{ELECTRON_VER}/electron-v{ELECTRON_VER}-darwin-{ARCH}.zip'
    print('下载', url)
    urllib.request.urlretrieve(url, ez)
print('electron zip:', ez, os.path.getsize(ez), 'bytes')

# 2. 组装应用目录(代码 + 生产依赖)并 asar 打包
src = os.path.join(WORK, 'app-src')
if os.path.exists(src):
    shutil.rmtree(src)
os.makedirs(src)
for item in ['main.js', 'sync-bridge.js', 'preload.js', 'core', 'plugins', 'renderer', 'assets', 'package.json']:
    dst = os.path.join(src, item)
    if os.path.isdir(os.path.join(APP_DIR, item)):
        shutil.copytree(os.path.join(APP_DIR, item), dst)
    else:
        shutil.copy2(os.path.join(APP_DIR, item), dst)
# 去掉构建专属字段,保留 main/version/dependencies
run(['npm', 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=src)
# 剔除 36MB 的 @napi-rs/canvas(PDF 提取已用 main.js 里的桩代码替代)
shutil.rmtree(os.path.join(src, 'node_modules', '@napi-rs'), ignore_errors=True)
asar = os.path.join(WORK, 'app.asar')
run(['npx', '--yes', 'asar@3', 'pack', src, asar])
print('app.asar:', os.path.getsize(asar), 'bytes')

# 3. 构建 macOS 图标(.icns,PNG 直嵌格式)
def build_icns(png_path, out_path):
    from PIL import Image
    import io as _io
    im = Image.open(png_path).convert('RGBA')
    entries = []
    for typ, size in [('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024)]:
        img = im if im.size == (size, size) else im.resize((size, size), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        data = buf.getvalue()
        entries.append(typ.encode() + (len(data) + 8).to_bytes(4, 'big') + data)
    body = b''.join(entries)
    with open(out_path, 'wb') as f:
        f.write(b'icns' + (len(body) + 8).to_bytes(4, 'big') + body)
    return out_path

icns_path = build_icns(os.path.join(APP_DIR, 'build', 'icon.png'), os.path.join(WORK, 'canvas.icns'))

# 4. 改写 zip:注入 app.asar + 自有图标,改包名与应用身份
import plistlib
APP_NAME = 'Canvas 课程管理'
OLD_PREFIX = 'Electron.app/'
NEW_PREFIX = APP_NAME + '.app/'
ASAR_IN_ZIP = NEW_PREFIX + 'Contents/Resources/app.asar'
DEFAULT_APP_IN_ZIP = OLD_PREFIX + 'Contents/Resources/default_app.asar'
PLIST_IN_ZIP = OLD_PREFIX + 'Contents/Info.plist'
ICNS_IN_ZIP = NEW_PREFIX + 'Contents/Resources/canvas.icns'
if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(ez) as zin,      zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
    for info in zin.infolist():
        if info.filename == DEFAULT_APP_IN_ZIP:
            continue
        data = zin.read(info)
        if info.filename == PLIST_IN_ZIP:
            pl = plistlib.loads(data)
            pl['CFBundleName'] = APP_NAME
            pl['CFBundleDisplayName'] = APP_NAME
            pl['CFBundleIdentifier'] = 'com.hkustgz.canvas-tool'
            pl['CFBundleIconFile'] = 'canvas.icns'
            pl['CFBundleShortVersionString'] = VER
            pl['CFBundleVersion'] = VER
            pl['NSHumanReadableCopyright'] = 'HKUST(GZ) Canvas 课程管理'
            data = plistlib.dumps(pl)
        info.filename = info.filename.replace(OLD_PREFIX, NEW_PREFIX, 1)
        # macOS 兼容:声明 Unix 宿主(避免 Info-ZIP 按 OEM 码页转换文件名),
        # 非 ASCII 名强制 UTF-8 标志位 + Info-ZIP Unicode Path 额外字段(0x7075)
        info.create_system = 3
        if any(ord(c) > 127 for c in info.filename):
            info.flag_bits |= 0x800
            legacy = info.filename.encode('utf-8')
            payload = b'' + zlib.crc32(legacy).to_bytes(4, 'little') + legacy
            extra = (0x7075).to_bytes(2, 'little') + len(payload).to_bytes(2, 'little') + payload
            info.extra = info.extra + extra
        zout.writestr(info, data)
    for name, payload in [(ASAR_IN_ZIP, open(asar, 'rb').read()), (ICNS_IN_ZIP, open(icns_path, 'rb').read())]:
        zi = zipfile.ZipInfo(name)
        zi.create_system = 3
        zi.flag_bits |= 0x800
        base = name.encode('utf-8')
        pay = b'' + zlib.crc32(base).to_bytes(4, 'little') + base
        zi.extra = (0x7075).to_bytes(2, 'little') + len(pay).to_bytes(2, 'little') + pay
        zi.external_attr = 0o644 << 16
        zout.writestr(zi, payload)
print('产出:', OUT, os.path.getsize(OUT), 'bytes')
