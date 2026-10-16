#!/usr/bin/env python
"""在 Windows 上手工组装 Linux .deb(electron-builder 需要 fpm,Windows 没有)。

结构: opt/canvas-manager(Electron 运行时+应用 asar) + 桌面集成 + ar 打包
用法: python scripts/build-deb.py [版本号] [架构,默认 amd64]
产物: dist/canvas-manager-<ver>-<arch>.deb
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = json.load(open(os.path.join(APP_DIR, 'package.json'), encoding='utf-8'))
VER = sys.argv[1] if len(sys.argv) > 1 else PKG['version']
ARCH = sys.argv[2] if len(sys.argv) > 2 else 'amd64'
ELECTRON_VER = PKG['devDependencies']['electron'].lstrip('^')  # 与 Windows 版一致的 44.2.0
EL_ARCH = 'x64' if ARCH == 'amd64' else 'arm64'
MIRROR = 'https://npmmirror.com/mirrors/electron/'
WORK = os.path.join(APP_DIR, 'dist', 'deb-build')
OUT = os.path.join(APP_DIR, 'dist', f'canvas-manager-{VER}-{ARCH}.deb')

def run(cmd, cwd=None):
    exe = shutil.which(cmd[0])
    if not exe:
        raise SystemExit(f'找不到命令: {cmd[0]}')
    print('>', ' '.join(cmd[:5]), '...')
    subprocess.run([exe] + cmd[1:], check=True, cwd=cwd)

# 1. Electron linux 运行时
run(['node', os.path.join(APP_DIR, 'scripts', 'plugin-catalog.cjs'), '--check'], cwd=APP_DIR)
ez = os.path.join(WORK, f'electron-v{ELECTRON_VER}-linux-{EL_ARCH}.zip')
os.makedirs(WORK, exist_ok=True)
if not os.path.exists(ez):
    url = f'{MIRROR}{ELECTRON_VER}/electron-v{ELECTRON_VER}-linux-{EL_ARCH}.zip'
    print('下载', url)
    urllib.request.urlretrieve(url, ez)
runtime = os.path.join(WORK, 'runtime')
if os.path.exists(runtime):
    shutil.rmtree(runtime)
os.makedirs(runtime)
with zipfile.ZipFile(ez) as z:
    z.extractall(runtime)

# 2. 应用 asar(代码+生产依赖,剔除 @napi-rs 36MB——PDF 提取已用桩代码替代)
src = os.path.join(WORK, 'app-src')
if os.path.exists(src):
    shutil.rmtree(src)
os.makedirs(src)
for item in ['main.js', 'sync-bridge.js', 'preload.js', 'core', 'plugins', 'renderer', 'assets', 'package.json']:
    if os.path.isdir(os.path.join(APP_DIR, item)):
        shutil.copytree(os.path.join(APP_DIR, item), os.path.join(src, item))
    else:
        shutil.copy2(os.path.join(APP_DIR, item), os.path.join(src, item))
run(['npm', 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=src)
shutil.rmtree(os.path.join(src, 'node_modules', '@napi-rs'), ignore_errors=True)
asar = os.path.join(WORK, 'app.asar')
run(['npx', '--yes', 'asar@3', 'pack', src, asar])

# 3. 组包目录树
tree = os.path.join(WORK, 'tree')
if os.path.exists(tree):
    shutil.rmtree(tree)
opt = os.path.join(tree, 'opt', 'canvas-manager')
os.makedirs(opt)
for item in os.listdir(runtime):
    shutil.move(os.path.join(runtime, item), os.path.join(opt, item))
os.rename(os.path.join(opt, 'electron'), os.path.join(opt, 'canvas-manager'))
os.remove(os.path.join(opt, 'resources', 'default_app.asar'))
shutil.copy2(asar, os.path.join(opt, 'resources', 'app.asar'))
os.remove(os.path.join(opt, 'LICENSE'))  # 避免和 LICENSE.electron.txt 冲突

apps = os.path.join(tree, 'usr', 'share', 'applications')
os.makedirs(apps)
open(os.path.join(apps, 'canvas-manager.desktop'), 'w', encoding='utf-8').write(
    '[Desktop Entry]\n'
    'Name=Canvas 课程管理\n'
    'Name[en]=Canvas Manager\n'
    'Exec=/opt/canvas-manager/canvas-manager %U\n'
    'Icon=canvas-manager\n'
    'Type=Application\n'
    'Categories=Education;\n'
    'StartupWMClass=Canvas 课程管理\n'
    'Comment=HKUST-GZ Canvas 作业/课件/AI 导学\n')
icons = os.path.join(tree, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps')
os.makedirs(icons)
shutil.copy2(os.path.join(APP_DIR, 'build', 'icon.png'), os.path.join(icons, 'canvas-manager.png'))
binDir = os.path.join(tree, 'usr', 'bin')
os.makedirs(binDir)
os.symlink('../opt/canvas-manager/canvas-manager', os.path.join(binDir, 'canvas-manager'))

# 4. control + 脚本
ctrl = os.path.join(WORK, 'ctrl')
if os.path.exists(ctrl):
    shutil.rmtree(ctrl)
os.makedirs(ctrl)
open(os.path.join(ctrl, 'control'), 'w', encoding='utf-8').write(
    f'Package: canvas-manager\nVersion: {VER}\nArchitecture: {ARCH}\n'
    'Maintainer: SixMonthFly\n'
    'Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libsecret-1-0, libgbm1, libasound2\n'
    'Section: education\nPriority: optional\n'
    'Description: HKUST-GZ Canvas 课程管理桌面工具\n'
    ' 作业/公告/课件/AI 导学报告/截止提醒。\n')
open(os.path.join(ctrl, 'postinst'), 'w', encoding='utf-8').write(
    '#!/bin/sh\n'
    'chmod 4755 /opt/canvas-manager/chrome-sandbox 2>/dev/null || true\n'
    'chmod 755 /opt/canvas-manager/canvas-manager\n'
    'update-desktop-database /usr/share/applications 2>/dev/null || true\n'
    'exit 0\n')

# 5. tar 归档(owner=root,preserve symlink)+ ar 打包成 deb
def make_tar(outpath, root, mode='w:gz'):
    with tarfile.open(outpath, mode) as t:
        for item in os.listdir(root):
            t.add(os.path.join(root, item), arcname=item, recursive=True)
    # python tarfile 在 Windows 下 owner 默认为当前用户,改写为 root:root
    with tarfile.open(outpath) as t:
        members = t.getmembers()
        for m in members:
            m.uid = m.gid = 0
            m.uname = m.gname = 'root'
    # 重新写出(直接在副本上改)
    tmp = outpath + '.tmp'
    with tarfile.open(outpath) as src_t, tarfile.open(tmp, mode) as dst_t:
        for m in members:
            f = src_t.extractfile(m) if m.isfile() else None
            m.offset = m.offset_data = 0
            dst_t.addfile(m, f)
    os.replace(tmp, outpath)

make_tar(os.path.join(WORK, 'control.tar.gz'), ctrl)
make_tar(os.path.join(WORK, 'data.tar.gz'), tree)
open(os.path.join(WORK, 'debian-binary'), 'w').write('2.0\n')

def ar_member(name, data):
    header = name.ljust(16) + str(int(time.time())).ljust(12) + '0'.ljust(6) + '0'.ljust(6) \
        + '100644'.ljust(8) + str(len(data)).ljust(10) + '`\n'
    out = header.encode() + data
    if len(data) % 2:
        out += b'\n'
    return out

with open(OUT, 'wb') as deb:
    deb.write(b'!<arch>\n')
    for name in ['debian-binary', 'control.tar.gz', 'data.tar.gz']:
        with open(os.path.join(WORK, name), 'rb') as f:
            deb.write(ar_member(name, f.read()))
print('产出:', OUT, os.path.getsize(OUT), 'bytes')
