#!/usr/bin/env node
// Build the public website into <out>/site. Never copy the app, user data,
// credentials, local server, or unlicensed photo.
import { readFile, writeFile, mkdir, copyFile, cp, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(site);
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const repository = value('--repository');
if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use --repository OWNER/REPOSITORY.');
const output = path.resolve(value('--out') || path.join(root, 'output/pages'));
const app = path.join(root, 'app');
if ([root, site, app].some(source => output === source || source.startsWith(output + path.sep)) ||
    [site, app].some(source => output.startsWith(source + path.sep))) {
  throw new Error('Choose a separate output directory outside website/ and app/.');
}

// App source versions can advance before either public installer is released.
// website/mac-release.json records the reviewed public Mac installer; publishing
// a newly built Mac DMG requires an explicit --mac-version/--version.
const explicitMacVersion = value('--mac-version') || value('--version');
const metadataPath = path.resolve(value('--release-metadata') || path.join(site, 'mac-release.json'));
let mac;
if (explicitMacVersion) {
  const version = explicitMacVersion.replace(/^v/, '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('Use --mac-version X.Y.Z.');
  const filename = `CanvasManager-${version}-mac-arm64.dmg`;
  const artifact = path.join(app, 'dist', filename);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) digest.update(chunk);
  mac = { version, tag: `v${version}`, filename, size: (await stat(artifact)).size, sha256: digest.digest('hex') };
} else {
  let reviewed;
  try { reviewed = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('No reviewed Mac release metadata. Use --release-metadata FILE or --mac-version X.Y.Z; the app source version is not a published release.');
  }
  const pkg = reviewed.packages?.mac || reviewed;
  mac = Object.fromEntries(['version', 'tag', 'filename', 'size', 'sha256'].map(field => [field, pkg[field]]));
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(mac.version) || mac.tag !== `v${mac.version}` ||
    mac.filename !== `CanvasManager-${mac.version}-mac-arm64.dmg` ||
    !Number.isSafeInteger(mac.size) || mac.size <= 0 || !/^[a-f0-9]{64}$/.test(mac.sha256)) {
  throw new Error('Invalid reviewed Mac release metadata.');
}
const macArtifact = path.join(app, 'dist', mac.filename);
try {
  const artifactStat = await stat(macArtifact);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(macArtifact)) digest.update(chunk);
  if (artifactStat.size !== mac.size || digest.digest('hex') !== mac.sha256) {
    throw new Error('Mac installer differs from the reviewed stable release.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Existing public releases remain describable without a local installer.
  // CI still verifies the GitHub asset before enabling the download.
}
const release = { ...mac, available: false,
  url: repository ? `https://github.com/${repository}/releases/download/${mac.tag}/${mac.filename}` : null };
const target = path.join(output, 'site');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await mkdir(path.join(target, 'assets'), { recursive: true });
for (const filename of ['index.html', 'styles.css', 'site.js', 'locales.js']) await copyFile(path.join(site, filename), path.join(target, filename));
for (const filename of ['favicon.svg', 'ai-homework.svg', 'widget-preview.svg', 'ai-homework-en.svg', 'widget-preview-en.svg', 'og-zh.jpg', 'og-en.jpg']) await copyFile(path.join(site, 'assets', filename), path.join(target, 'assets', filename));
await mkdir(path.join(target, 'assets/product'), { recursive: true });
for (const scene of ['home', 'overview', 'assignments', 'announcements', 'files']) {
  for (const language of ['zh', 'en']) {
    for (const ext of ['png', 'webp']) {
      const filename = `${scene}-${language}.${ext}`;
      await copyFile(path.join(site, 'assets/product', filename), path.join(target, 'assets/product', filename));
    }
  }
}
await cp(path.join(site, 'en'), path.join(target, 'en'), { recursive: true });
// demo/ also hosts the site's Source Serif 4 font.
await cp(path.join(site, 'demo'), path.join(target, 'demo'), { recursive: true });
await copyFile(path.join(site, 'assets/SOURCES.md'), path.join(target, 'assets/SOURCES.md'));
await writeFile(path.join(target, '.nojekyll'), '');

const windows = JSON.parse(await readFile(path.join(site, 'windows-release.json'), 'utf8'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(windows.version) ||
    windows.tag !== `v${windows.version}` ||
    windows.filename !== `CanvasManager-Setup-${windows.version}-x64.exe` ||
    !Number.isSafeInteger(windows.size) || windows.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(windows.sha256)) throw new Error('Invalid reviewed Windows release metadata.');
const windowsArtifact = path.join(root, 'app/dist', windows.filename);
try {
  const windowsStat = await stat(windowsArtifact);
  const windowsDigest = createHash('sha256');
  for await (const chunk of createReadStream(windowsArtifact)) windowsDigest.update(chunk);
  if (windowsStat.size !== windows.size || windowsDigest.digest('hex') !== windows.sha256) {
    throw new Error('Windows installer differs from the reviewed stable release.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // A clean website checkout can still describe the reviewed public installer.
  // CI alone enables its link after validating the actual GitHub Release asset.
}
windows.available = false;
windows.url = repository ? `https://github.com/${repository}/releases/download/${windows.tag}/${windows.filename}` : null;
release.schemaVersion = 2;
// Preserve the top-level Mac fields for clients that have cached the old JS.
release.packages = { mac: { ...release }, windows };
delete release.packages.mac.schemaVersion;
await writeFile(path.join(target, 'release.json'), JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify({ output, repository: repository ?? null, release, files: 'allowlisted website files only' }, null, 2));
