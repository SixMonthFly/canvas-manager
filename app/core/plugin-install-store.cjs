const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

function failure(message) {
  const error = new Error(`PLUGIN_INTEGRITY: ${message}`);
  error.code = 'PLUGIN_INTEGRITY';
  return error;
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0')
      || value.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(value)) {
    throw failure('插件文件路径无效');
  }
  return value;
}
function validateManifest(manifest) {
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id) || manifest.apiVersion !== 1
      || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
      || !Array.isArray(manifest.requires) || manifest.requires.some(key => typeof key !== 'string')
      || (manifest.defaultInstalled !== undefined && typeof manifest.defaultInstalled !== 'boolean')
      || (manifest.kind !== undefined && (typeof manifest.kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.kind)))
      || (manifest.kind === 'theme' && (typeof manifest.themeId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.themeId)))
      || !Array.isArray(manifest.files) || !manifest.files.length) throw failure('插件清单无效');
  relative(manifest.source); relative(manifest.main); relative(manifest.renderer);
  const names = new Set();
  for (const file of manifest.files) {
    const name = relative(file.path);
    if (names.has(name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw failure('文件清单重复或校验值无效');
    names.add(name.toLowerCase());
  }
  if (!manifest.files.some(file => file.path === manifest.main)
      || !manifest.files.some(file => file.path === manifest.renderer)) throw failure('插件入口不在可信文件清单中');
}
function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('插件目录不能是符号链接或普通文件');
}
function walk(directory, prefix = '') {
  assertDirectory(directory);
  const names = [];
  for (const item of fs.readdirSync(directory).sort()) {
    const filename = path.join(directory, item);
    const name = prefix ? `${prefix}/${item}` : item;
    relative(name);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw failure('插件包不能包含符号链接');
    if (stat.isDirectory()) names.push(...walk(filename, name));
    else if (stat.isFile()) names.push(name);
    else throw failure('插件包不能包含特殊文件');
  }
  return names;
}
function readVerifiedFile(root, file) {
  let current = root;
  const parts = relative(file.path).split('/');
  assertDirectory(root);
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); assertDirectory(current); }
  const filename = path.join(current, parts.at(-1));
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('插件代码不能是符号链接或特殊文件');
  const data = fs.readFileSync(filename);
  if (crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) throw failure(`插件文件校验失败：${file.path}`);
  return data;
}
function verifyDirectory(root, manifest) {
  validateManifest(manifest);
  const actual = walk(root);
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw failure('插件包存在缺失或未列入清单的文件');
  for (const file of manifest.files) readVerifiedFile(root, file);
}

function createPluginInstallStore({ bundleRoot, installRoot }) {
  if (!bundleRoot || !installRoot) throw failure('缺少插件源或安装目录');
  bundleRoot = path.resolve(bundleRoot); installRoot = path.resolve(installRoot);
  function ensureRoot() {
    fs.mkdirSync(path.dirname(installRoot), { recursive: true });
    assertDirectory(path.dirname(installRoot));
    fs.mkdirSync(installRoot, { recursive: true }); assertDirectory(installRoot);
  }
  function parent(id) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw failure('插件 ID 无效');
    ensureRoot();
    const directory = path.join(installRoot, id);
    fs.mkdirSync(directory, { recursive: true }); assertDirectory(directory);
    return directory;
  }
  function location(manifest, record) {
    if (!record || !/^[a-f0-9]{32}$/.test(record.generation)) throw failure('安装代次无效');
    const root = path.join(parent(manifest.id), record.generation);
    return { root, mainPath: path.join(root, manifest.main), generation: record.generation,
      renderer: `${pathToFileURL(path.join(root, manifest.renderer)).href}?generation=${record.generation}` };
  }
  function stage(manifest) {
    validateManifest(manifest);
    let source = bundleRoot;
    for (const part of manifest.source.split('/')) { source = path.join(source, part); assertDirectory(source); }
    verifyDirectory(source, manifest);
    const generation = crypto.randomBytes(16).toString('hex');
    const root = path.join(parent(manifest.id), `.stage-${generation}`);
    const staged = { manifest, generation, root, finalRoot: path.join(parent(manifest.id), generation), committed: false };
    fs.mkdirSync(root, { mode: 0o700 });
    try {
      for (const file of manifest.files) {
        const target = path.join(root, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readVerifiedFile(source, file), { flag: 'wx', mode: 0o600 });
      }
      verifyDirectory(root, manifest);
      return staged;
    } catch (error) { discard(staged); throw error; }
  }
  function commit(staged) {
    assertDirectory(parent(staged.manifest.id));
    verifyDirectory(staged.root, staged.manifest);
    fs.renameSync(staged.root, staged.finalRoot); staged.committed = true;
    return { installed: true, enabled: false, generation: staged.generation,
      version: staged.manifest.version, apiVersion: staged.manifest.apiVersion };
  }
  function discard(staged) {
    if (!staged) return;
    assertDirectory(parent(staged.manifest.id));
    fs.rmSync(staged.committed ? staged.finalRoot : staged.root, { recursive: true, force: true });
  }
  function verify(manifest, record) {
    if (record.version !== manifest.version || record.apiVersion !== manifest.apiVersion) throw failure('已安装插件与当前可信包版本不符，请重新安装');
    const target = location(manifest, record);
    verifyDirectory(target.root, manifest);
    target.cacheRoot = fs.realpathSync(target.root);
    return target;
  }
  function quarantine(manifest, record) {
    const target = location(manifest, record);
    assertDirectory(parent(manifest.id));
    if (!fs.existsSync(target.root) && !fs.lstatSync(target.root, { throwIfNoEntry: false })) return null;
    const trash = path.join(parent(manifest.id), `.remove-${record.generation}`);
    if (fs.existsSync(trash)) throw failure('存在未完成的卸载，请检查安装目录');
    fs.renameSync(target.root, trash);
    return { original: target.root, trash, id: manifest.id };
  }
  function restore(token) { if (token) { assertDirectory(parent(token.id)); fs.renameSync(token.trash, token.original); } }
  function erase(token) { if (token) { assertDirectory(parent(token.id)); fs.rmSync(token.trash, { recursive: true, force: true }); } }
  function recover(manifest, record) {
    const directory = parent(manifest.id);
    const current = record.installed && /^[a-f0-9]{32}$/.test(record.generation) ? record.generation : null;
    for (const name of fs.readdirSync(directory)) {
      if (!/^(?:\.stage-|\.remove-)?[a-f0-9]{32}$/.test(name)) throw failure('安装目录包含未识别的文件');
      const filename = path.join(directory, name);
      if (name === current) continue;
      if (current && name === `.remove-${current}`) {
        const original = path.join(directory, current);
        if (!fs.lstatSync(original, { throwIfNoEntry: false })) { fs.renameSync(filename, original); continue; }
      }
      // These are generation entries, never user configuration or course data.
      fs.rmSync(filename, { recursive: true, force: true });
    }
  }
  return { stage, commit, discard, verify, location, quarantine, restore, erase, recover };
}

function releaseInstalledPlugin(installation) {
  const prefix = (installation.cacheRoot || installation.root) + path.sep;
  for (const filename of Object.keys(require.cache)) {
    if (filename.startsWith(prefix)) delete require.cache[filename];
  }
}
function loadInstalledPlugin(_manifest, installation) {
  releaseInstalledPlugin(installation);
  return require(installation.mainPath);
}
module.exports = { createPluginInstallStore, loadInstalledPlugin, releaseInstalledPlugin, validateManifest, verifyDirectory, walk, relative, failure };
