const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function verifyExtensionEntry(executable) {
  const commands = execFileSync('xcrun', ['otool', '-l', executable], { encoding: 'utf8' });
  const symbols = execFileSync('xcrun', ['otool', '-Iv', executable], { encoding: 'utf8' });
  const textBase = commands.match(/segname __TEXT\s+vmaddr (0x[0-9a-f]+)/i);
  const entryOffset = commands.match(/cmd LC_MAIN\s+cmdsize \d+\s+entryoff (\d+)/);
  const extensionEntry = [...symbols.matchAll(/^(0x[0-9a-f]+)\s+\d+\s+_NSExtensionMain$/gmi)];
  if (!textBase || !entryOffset || !extensionEntry.some(match =>
    BigInt(match[1]) === BigInt(textBase[1]) + BigInt(entryOffset[1]))) {
    throw new Error('Widget executable must enter through Foundation NSExtensionMain');
  }
}

function buildNativeWidget({ output, arch = process.arch } = {}) {
  if (process.platform !== 'darwin') throw new Error('Native widget compilation requires macOS');
  if (!['arm64', 'x86_64'].includes(arch)) throw new Error('Unsupported native widget architecture');
  const root = path.join(__dirname, '..', 'native', 'macos-widget');
  output ||= path.join(__dirname, '..', '..', 'output', 'native-widget', 'native');
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  const appex = path.join(output, 'CanvasAssignmentsWidget.appex');
  fs.mkdirSync(path.join(appex, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync(path.join(root, 'Info.plist'), path.join(appex, 'Contents', 'Info.plist'));
  const base = ['swiftc', '-sdk', sdk, '-target', `${arch}-apple-macosx14.0`, '-O', '-parse-as-library',
    '-module-cache-path', path.join(output, 'module-cache'), path.join(root, 'WidgetData.swift')];
  execFileSync('xcrun', [...base, '-application-extension', path.join(root, 'CanvasAssignmentsWidget.swift'),
    // Foundation must establish the extension context before invoking Swift's @main.
    // Calling the ordinary executable entry point crashes ExtensionFoundation at bootstrap.
    '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
    '-o', path.join(appex, 'Contents', 'MacOS', 'CanvasAssignmentsWidget')], { stdio: 'inherit' });
  verifyExtensionEntry(path.join(appex, 'Contents', 'MacOS', 'CanvasAssignmentsWidget'));
  execFileSync('xcrun', [...base, path.join(root, 'WidgetBridge.swift'), '-o', path.join(output, 'CanvasWidgetBridge')], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', path.join(root, 'Widget.entitlements'), appex], { stdio: 'inherit' });
  return { appex, bridge: path.join(output, 'CanvasWidgetBridge') };
}
if (require.main === module) {
  try { console.log(buildNativeWidget()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildNativeWidget, verifyExtensionEntry };
