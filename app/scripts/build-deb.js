// 在 Windows 上手工构建 .deb(electron-builder 新版在 Windows 上不再内置 fpm)。
// deb = ar 归档: debian-binary + control.tar.gz + data.tar.gz
// 用法: node scripts/build-deb.js <unpacked目录> <amd64|arm64> <输出.deb> <版本>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- ustar tar ----------
function tarHeader(name, mode, size, typeflag, linkname, mtime) {
  const h = Buffer.alloc(512);
  // 名字超长用 prefix 拆分
  let prefix = '';
  let fname = name;
  if (fname.length > 100) {
    const idx = fname.slice(0, 155).lastIndexOf('/');
    prefix = fname.slice(0, idx);
    fname = fname.slice(idx + 1);
    if (fname.length > 100) throw new Error('tar 路径过长: ' + name);
  }
  h.write(fname.slice(0, 100), 0);
  h.write(mode.toString(8).padStart(7, '0') + ' ', 100);
  h.write('0000000 ', 108); // uid
  h.write('0000000 ', 116); // gid
  h.write(size.toString(8).padStart(11, '0') + ' ', 124);
  h.write((mtime || 0).toString(8).padStart(11, '0') + ' ', 136);
  h.write('        ', 148); // checksum 占位(空格)
  h.write(typeflag || '0', 156);
  if (linkname) h.write(linkname.slice(0, 100), 157);
  h.write('ustar\0', 257); h.write('00', 263);
  h.write('root', 265); h.write('root', 297);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function buildTar(entries) {
  const chunks = [];
  const push = (buf) => chunks.push(buf);
  for (const e of entries) {
    push(tarHeader(e.name, e.mode, e.size || 0, e.type, e.link, e.mtime));
    if (e.data) push(e.data);
    if (e.size % 512) push(Buffer.alloc(512 - (e.size % 512)));
  }
  push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(chunks);
}

// ---------- GNU ar ----------
function arEntry(name, data) {
  const h = Buffer.alloc(60);
  h.write(name.padEnd(16, ' '), 0);
  h.write('0           '.slice(0, 12), 16); // mtime
  h.write('0     ', 28); h.write('0     ', 34);
  h.write('100644  ', 40);
  h.write(data.length.toString().padStart(10, ' ') + '\`\n', 48);
  const pad = data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0);
  return Buffer.concat([h, data, pad]);
}

function walk(dir, base, out) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, item.name);
    const rel = base + '/' + item.name;
    if (item.isDirectory()) {
      out.push({ name: './' + rel, mode: 0o755, type: '5', mtime: 0 });
      walk(full, rel, out);
    } else if (item.isSymbolicLink()) {
      out.push({ name: './' + rel, mode: 0o777, type: '2', link: fs.readlinkSync(full), mtime: 0 });
    } else {
      const data = fs.readFileSync(full);
      const mtime = Math.floor(fs.statSync(full).mtimeMs / 1000);
      // chrome-sandbox 必须是 4755(SUID),否则 Chromium 沙箱起不来
      const mode = item.name === 'chrome-sandbox' ? 0o4755 : (data.length && (data[0] === 0x7f && data[1] === 0x45) ? 0o755 : 0o644);
      out.push({ name: './' + rel, mode, size: data.length, data, mtime });
    }
  }
  return out;
}

const [unpackedDir, debArch, outFile, version] = process.argv.slice(2);
if (!unpackedDir || !debArch || !outFile || !version) {
  console.error('用法: node build-deb.js <unpacked目录> <amd64|arm64> <输出.deb> <版本>');
  process.exit(1);
}

const control = [
  'Package: canvas-manager',
  `Version: ${version}`,
  'Section: education',
  'Priority: optional',
  `Architecture: ${debArch}`,
  'Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libsecret-1-0, libgbm1, libasound2',
  'Maintainer: SixMonthFly',
  'Homepage: https://github.com/SixMonthFly/canvas-manager',
  'Description: HKUST-GZ Canvas 课程管理桌面工具',
  ' 作业/公告/课件管理,AI 导学报告与作业方案,截止提醒。',
].join('\n') + '\n';

const postinst = [
  '#!/bin/sh',
  "chmod 4755 '/opt/canvas-manager/chrome-sandbox' 2>/dev/null || true",
  "command -v update-desktop-database >/dev/null && update-desktop-database || true",
  'exit 0',
].join('\n');

const desktop = Buffer.from([
  '[Desktop Entry]',
  'Name=Canvas 课程管理',
  'Comment=HKUST-GZ Canvas 课程管理(作业/公告/课件/AI 导学)',
  'Exec=/opt/canvas-manager/canvas-manager %U',
  'Icon=canvas-manager',
  'Terminal=false',
  'Type=Application',
  'Categories=Education;',
].join('\n'), 'utf-8');

// 注意:含中文的字符串必须用 Buffer.byteLength / Buffer.from(...).length,size 按字节算
const controlBuf = Buffer.from(control, 'utf-8');
const postinstBuf = Buffer.from(postinst, 'utf-8');
const controlTar = buildTar([
  { name: './control', mode: 0o644, size: controlBuf.length, data: controlBuf, mtime: 0 },
  { name: './postinst', mode: 0o755, size: postinstBuf.length, data: postinstBuf, mtime: 0 },
]);

// This input is an electron-builder runtime directory, not the source app.
// Its app.asar already contains main/preload/sync-bridge, core/ and plugins/
// according to package.json build.files; do not copy source or dev dependencies here.
const dataEntries = walk(path.resolve(unpackedDir), 'opt/canvas-manager', []);
dataEntries.push({ name: './usr/bin', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/bin/canvas-manager', mode: 0o777, type: '2', link: '/opt/canvas-manager/canvas-manager', mtime: 0 });
dataEntries.push({ name: './usr/share/applications', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/share/applications/canvas-manager.desktop', mode: 0o644, size: desktop.length, data: desktop, mtime: 0 });
const icon = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
dataEntries.push({ name: './usr/share/icons', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/share/icons/hicolor', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/share/icons/hicolor/512x512', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/share/icons/hicolor/512x512/apps', mode: 0o755, type: '5', mtime: 0 });
dataEntries.push({ name: './usr/share/icons/hicolor/512x512/apps/canvas-manager.png', mode: 0o644, size: icon.length, data: icon, mtime: 0 });
const dataTar = buildTar(dataEntries);

const deb = Buffer.concat([
  Buffer.from('!<arch>\n'),
  arEntry('debian-binary/', Buffer.from('2.0\n')),
  arEntry('control.tar.gz/', zlib.gzipSync(controlTar, { level: 9 })),
  arEntry('data.tar.gz/', zlib.gzipSync(dataTar, { level: 9 })),
]);
fs.writeFileSync(outFile, deb);
console.log(`deb 写入 ${outFile}(${(deb.length / 1048576).toFixed(1)} MB,${dataEntries.length} 个条目)`);
