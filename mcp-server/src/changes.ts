import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalData } from './localFeatures.js';
import { assignmentStatus } from './localFeatures.js';
import { formatDeadline } from './time.js';

type Item = { kind: 'assignment' | 'announcement'; courseId: number; id: number; name: string;
  dueAt?: string | null; status?: string; contentHash?: string; published?: boolean; postedAt?: string | null };
type RecordSet = Record<string, Item>;
export type Change = { kind: 'assignment' | 'announcement'; action: 'added' | 'removed' | 'changed';
  courseId: number; id: number; name: string; fields?: string[]; dueBefore?: string; dueAfter?: string };
type State = { version: 1; snapshot: RecordSet; lastChanges: Change[]; comparedAt: string | null; lastSyncAt: string | null };

const hash = (text: string | null | undefined) => createHash('sha256').update(text || '').digest('hex');
const key = (item: Item) => `${item.kind}:${item.courseId}:${item.id}`;

export function captureSnapshot(data: LocalData): RecordSet {
  const result: RecordSet = {};
  for (const course of data.courses) {
    for (const a of data.byCourse[course.id] || []) {
      const item: Item = { kind: 'assignment', courseId: course.id, id: a.id, name: a.name,
        dueAt: a.due_at, status: assignmentStatus(a), published: a.published, contentHash: hash(a.description) };
      result[key(item)] = item;
    }
    for (const ann of data.annBy[course.id] || []) {
      const item: Item = { kind: 'announcement', courseId: course.id, id: ann.id, name: ann.title,
        postedAt: ann.posted_at, contentHash: hash(ann.message) };
      result[key(item)] = item;
    }
  }
  return result;
}

function compare(before: RecordSet, after: RecordSet): Change[] {
  const changes: Change[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[id], now = after[id];
    const item = now || old;
    if (!old || !now) {
      changes.push({ kind: item.kind, action: old ? 'removed' : 'added', courseId: item.courseId,
        id: item.id, name: item.name });
      continue;
    }
    const fields = ['name', 'dueAt', 'status', 'published', 'postedAt', 'contentHash']
      .filter(field => old[field as keyof Item] !== now[field as keyof Item]);
    if (!fields.length) continue;
    changes.push({ kind: now.kind, action: 'changed', courseId: now.courseId, id: now.id,
      name: now.name, fields: fields.map(f => f === 'contentHash' ? 'content' : f),
      ...(old.dueAt !== now.dueAt ? { dueBefore: formatDeadline(old.dueAt), dueAfter: formatDeadline(now.dueAt) } : {}) });
  }
  return changes.sort((a, b) => a.courseId - b.courseId || a.id - b.id || a.action.localeCompare(b.action));
}

function statePath(dataDir: string) { return join(dataDir, 'mcp_changes.json'); }
function readState(dataDir: string): State | null {
  try {
    const path = statePath(dataDir);
    if (!existsSync(path)) return null;
    const state = JSON.parse(readFileSync(path, 'utf-8')) as State;
    return state.version === 1 && state.snapshot && Array.isArray(state.lastChanges) ? state : null;
  } catch { return null; }
}
function writeState(dataDir: string, state: State) {
  const path = statePath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), 'utf-8');
  renameSync(temporary, path);
}

export function readChanges(dataDir: string, data: LocalData, syncAt: string | null = null) {
  const current = captureSnapshot(data);
  const state = readState(dataDir);
  if (!state) {
    writeState(dataDir, { version: 1, snapshot: current, lastChanges: [], comparedAt: null, lastSyncAt: syncAt });
    return { baselineAvailable: false, comparedAt: null, changes: [] as Change[] };
  }
  const changes = compare(state.snapshot, current);
  if (changes.length) {
    const comparedAt = new Date().toISOString();
    writeState(dataDir, { version: 1, snapshot: current, lastChanges: changes, comparedAt, lastSyncAt: syncAt });
    return { baselineAvailable: true, comparedAt, changes };
  }
  if (syncAt && state.lastSyncAt && syncAt !== state.lastSyncAt) {
    const comparedAt = new Date().toISOString();
    writeState(dataDir, { version: 1, snapshot: current, lastChanges: [], comparedAt, lastSyncAt: syncAt });
    return { baselineAvailable: true, comparedAt, changes: [] as Change[] };
  }
  return { baselineAvailable: true, comparedAt: state.comparedAt, changes: state.lastChanges };
}

export function setBaseline(dataDir: string, data: LocalData, syncAt: string | null = null) {
  const previous = readState(dataDir);
  writeState(dataDir, { version: 1, snapshot: captureSnapshot(data),
    lastChanges: previous?.lastChanges || [], comparedAt: previous?.comparedAt || null, lastSyncAt: syncAt });
}
