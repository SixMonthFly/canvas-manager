import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function activeDataDir(root: string): string {
  const file = join(root, 'active-school.json');
  if (!existsSync(file)) return root;
  const { schoolId } = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof schoolId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(schoolId)) throw new Error('无效的学校数据目录');
  return schoolId === 'hkust-gz' ? root : join(root, 'schools', schoolId);
}
export function canvasOrigin(dataDir: string): string {
  const file = join(dataDir, 'school-context.json');
  if (!existsSync(file)) return 'https://hkust-gz.instructure.com';
  const { origin } = JSON.parse(readFileSync(file, 'utf8'));
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('无效的 Canvas 地址');
  return origin;
}
