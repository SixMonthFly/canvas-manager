const fs = require('node:fs');
const path = require('node:path');
const { buildNativeWidget } = require('./build-native-widget.cjs');

module.exports = context => {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = context.arch === 1 ? 'x86_64' : context.arch === 3 ? 'arm64' : null;
  if (!arch) throw new Error('Native widget packaging supports arm64 or x64 Mac targets');
  const native = buildNativeWidget({ arch });
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents');
  fs.mkdirSync(path.join(contents, 'PlugIns'), { recursive: true });
  fs.cpSync(native.appex, path.join(contents, 'PlugIns', 'CanvasAssignmentsWidget.appex'), { recursive: true });
  fs.copyFileSync(native.bridge, path.join(contents, 'MacOS', 'CanvasWidgetBridge'));
};
