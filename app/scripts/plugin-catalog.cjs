const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { relative, walk, validateManifest, verifyDirectory } = require('../core/plugin-install-store.cjs');

function options(value = {}) {
  const appDir = value.appDir || path.join(__dirname, '..');
  return { appDir, catalogPath: value.catalogPath || path.join(appDir, 'plugins', 'catalog.json') };
}
function checkCatalog(value) {
  const { appDir, catalogPath } = options(value);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  for (const manifest of catalog) {
    validateManifest(manifest);
    verifyDirectory(path.join(appDir, manifest.source), manifest);
  }
  return catalog;
}
function writeCatalog(value) {
  const { appDir, catalogPath } = options(value);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  for (const manifest of catalog) {
    const root = path.join(appDir, relative(manifest.source));
    manifest.files = walk(root).map(name => ({ path: name,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') }));
    validateManifest(manifest);
  }
  const temporary = `${catalogPath}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n'); fs.renameSync(temporary, catalogPath); }
  finally { fs.rmSync(temporary, { force: true }); }
  return checkCatalog({ appDir, catalogPath });
}
if (require.main === module) {
  try {
    if (process.argv[2] === '--write') { writeCatalog(); console.log('Trusted bundled plugin hashes regenerated.'); }
    else if (process.argv[2] === '--check') { checkCatalog(); console.log('Trusted bundled plugin hashes verified.'); }
    else throw new Error('Usage: node app/scripts/plugin-catalog.cjs --write | --check');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkCatalog, writeCatalog };
