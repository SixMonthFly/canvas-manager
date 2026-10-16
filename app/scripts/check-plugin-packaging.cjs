const { execFileSync } = require('node:child_process');
const path = require('node:path');

// The trusted catalog must describe the exact plugin payload being packaged.
// Refuse a stale checksum rather than ship an app unable to install its plugin.
module.exports = () => {
  execFileSync(process.execPath, [path.join(__dirname, 'plugin-catalog.cjs'), '--check'], { stdio: 'inherit' });
};
