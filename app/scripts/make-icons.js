// Render the Canvas Manager C + check mark vector and the macOS alpha mask.
// Build-time only; the desktop app has no canvas dependency.
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const assets = path.join(__dirname, '..', 'assets', 'icons');
const build = path.join(__dirname, '..', 'build');

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function withDpi(png, dpi) {
  const data = Buffer.alloc(9), chunk = Buffer.alloc(21);
  data.writeUInt32BE(Math.round(dpi / 0.0254), 0);
  data.writeUInt32BE(Math.round(dpi / 0.0254), 4); data[8] = 1;
  chunk.writeUInt32BE(9, 0); chunk.write('pHYs', 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}
async function render(svg, size, dpi = 72) {
  const source = svg.replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`);
  const image = await loadImage(Buffer.from(source));
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  return withDpi(canvas.toBuffer('image/png'), dpi);
}
async function main() {
  fs.mkdirSync(build, { recursive: true });
  const app = fs.readFileSync(path.join(assets, 'app.svg'), 'utf8');
  const template = fs.readFileSync(path.join(assets, 'menuBarTemplate.svg'), 'utf8');
  fs.writeFileSync(path.join(build, 'icon.png'), await render(app, 1024));
  fs.writeFileSync(path.join(assets, 'app-256.png'), await render(app, 256));
  fs.writeFileSync(path.join(assets, 'menuBarTemplate.png'), await render(template, 20));
  fs.writeFileSync(path.join(assets, 'menuBarTemplate@2x.png'), await render(template, 40, 144));
  const sizes = [16, 32, 48, 64, 128, 256], entries = [], pngs = [];
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  for (const size of sizes) {
    const png = await render(app, size), entry = Buffer.alloc(16);
    entry[0] = entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    offset += png.length; entries.push(entry); pngs.push(png);
  }
  fs.writeFileSync(path.join(build, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  console.log('Canvas Manager application icons and transparent Retina menu bar templates generated.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
