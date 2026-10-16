#!/usr/bin/env node
'use strict';

// Package the already-built Apple Silicon app. This does not rebuild or sign it.
// Usage: node website/scripts/build-dmg.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const appDir = path.join(root, 'app');
const metadata = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const appName = 'Canvas 课程管理';
const bundle = path.join(appDir, 'dist', 'mac-arm64', `${appName}.app`);
const resourceDir = path.join(appDir, 'dist', '.website-dmg');
const artifact = `CanvasManager-${metadata.version}-mac-arm64.dmg`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  }
  return (result.stdout || '').trim();
}

if (process.platform !== 'darwin') throw new Error('Build this DMG on macOS.');
if (!fs.existsSync(bundle)) throw new Error(`Missing prebuilt application: ${bundle}`);
const bundleVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleShortVersionString', path.join(bundle, 'Contents/Info.plist')]);
if (bundleVersion !== metadata.version) throw new Error(`Bundle version ${bundleVersion} does not match package version ${metadata.version}. Rebuild the app first.`);
const executable = path.join(bundle, 'Contents/MacOS', appName);
if (!run('/usr/bin/lipo', ['-archs', executable]).split(/\s+/).includes('arm64')) throw new Error('The prebuilt app does not contain Apple Silicon code.');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
fs.mkdirSync(resourceDir, { recursive: true });

// Finder renders icon labels in its own foreground color. Pale icon wells keep
// those labels legible while the surrounding installation panel stays navy.
const { createCanvas, GlobalFonts } = require(path.join(appDir, 'node_modules/@napi-rs/canvas'));
// Explicit registration is necessary: the canvas runtime does not discover
// every macOS font collection automatically.
const chineseFont = '/System/Library/Fonts/STHeiti Medium.ttc';
if (!GlobalFonts.registerFromPath(chineseFont, 'Canvas Chinese')) throw new Error(`Cannot load Chinese font: ${chineseFont}`);
function drawBackground(scale) {
  const canvas = createCanvas(640 * scale, 420 * scale);
  const c = canvas.getContext('2d');
  c.scale(scale, scale);
  const bg = c.createLinearGradient(0, 0, 640, 420);
  bg.addColorStop(0, '#fafbfd');
  bg.addColorStop(1, '#eaf1fb');
  c.fillStyle = bg;
  c.fillRect(0, 0, 640, 420);
  c.strokeStyle = 'rgba(147,197,253,0.06)';
  c.lineWidth = 1;
  for (let x = 0; x <= 640; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 420); c.stroke(); }
  for (let y = 0; y <= 420; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(640, y); c.stroke(); }
  c.fillStyle = '#235da0';
  c.font = '600 11px "Canvas Chinese", sans-serif';
  c.fillText('CANVAS FOR MAC', 40, 42);
  c.fillStyle = '#20242a';
  c.font = '600 29px "Canvas Chinese", sans-serif';
  c.fillText('Canvas Manager', 40, 86);
  c.fillStyle = '#697383';
  c.font = '14px "Canvas Chinese", sans-serif';
  c.fillText('拖入 Applications · Drag into Applications', 40, 117);
  for (const x of [86, 366]) {
    c.fillStyle = '#f2f6fb';
    c.beginPath(); c.roundRect(x, 166, 188, 146, 22); c.fill();
  }
  c.strokeStyle = '#235da0';
  c.lineWidth = 3;
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(295, 231); c.lineTo(344, 231); c.lineTo(333, 220); c.moveTo(344, 231); c.lineTo(333, 242); c.stroke();
  c.fillStyle = '#505966';
  c.font = '14px "Canvas Chinese", sans-serif';
  c.textAlign = 'center';
  c.fillText('从应用程序启动 · Open from Applications', 320, 359);
  c.fillStyle = '#697383';
  c.font = '11px "Canvas Chinese", sans-serif';
  c.fillText(`Apple Silicon · v${metadata.version}`, 320, 385);
  const filename = path.join(resourceDir, scale === 1 ? 'background.png' : 'background@2x.png');
  fs.writeFileSync(filename, canvas.toBuffer('image/png'));
}
drawBackground(1);
drawBackground(2);

const config = {
  appId: metadata.build.appId,
  productName: appName,
  directories: { output: path.join(appDir, 'dist'), buildResources: path.join(appDir, 'build') },
  compression: 'normal',
  mac: { target: ['dmg'], icon: path.join(appDir, 'build/icon.png'), identity: null, hardenedRuntime: false },
  dmg: {
    title: `${appName} ${metadata.version}`,
    artifactName: artifact,
    format: 'UDZO',
    sign: false,
    writeUpdateInfo: false,
    background: path.join(resourceDir, 'background.png'),
    iconSize: 88,
    iconTextSize: 13,
    contents: [
      { x: 180, y: 232, type: 'file', path: bundle, name: `${appName}.app` },
      { x: 460, y: 232, type: 'link', path: '/Applications', name: 'Applications' },
    ],
  },
};
const configFile = path.join(resourceDir, 'electron-builder.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
run(process.execPath, [
  path.join(appDir, 'node_modules/electron-builder/cli.js'),
  '--projectDir', appDir, '--mac', 'dmg', '--arm64',
  '--prepackaged', bundle, '--config', configFile, '--publish', 'never',
], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
console.log(`DMG ready: ${path.join(appDir, 'dist', artifact)}`);
