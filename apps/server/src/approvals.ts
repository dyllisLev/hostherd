import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError, hash, type Store } from './store.js';
import { redactText } from './request-logs.js';

// Destructive-operation policy for MCP tool calls. Command analysis is a
// guardrail against accidents, not a security boundary: anything it cannot
// place precisely asks for approval, and OS account permissions still apply.

export type RuleCategory = 'delete' | 'overwrite' | 'system' | 'custom';
export type RuleMode = 'confirm' | 'allow' | 'block';
export interface Rule { id: string; category: RuleCategory; name: string; defaultMode?: RuleMode }
export const RULES: Rule[] = [
  { id: 'rm-recursive', category: 'delete', name: 'rm -r (recursive delete)' },
  { id: 'rm', category: 'delete', name: 'rm (file delete)' },
  { id: 'find-delete', category: 'delete', name: 'find -delete / -exec rm' },
  { id: 'shred', category: 'delete', name: 'shred' },
  { id: 'remove-item', category: 'delete', name: 'Remove-Item / del / rd' },
  { id: 'file-delete', category: 'delete', name: 'file_delete tool' },
  { id: 'docker-remove', category: 'delete', name: 'docker rm / rmi / volume rm / prune, compose down -v' },
  { id: 'redirect', category: 'overwrite', name: '> redirection, Set-Content, Out-File' },
  { id: 'truncate', category: 'overwrite', name: 'truncate / Clear-Content' },
  { id: 'dd', category: 'overwrite', name: 'dd of=' },
  { id: 'file-overwrite', category: 'overwrite', name: 'file_write / file_upload replacing a file' },
  { id: 'git-discard', category: 'overwrite', name: 'git reset --hard / clean / checkout -- / restore' },
  { id: 'in-place-edit', category: 'overwrite', name: 'sed -i / perl -i / file_edit' },
  { id: 'permissions', category: 'overwrite', name: 'chmod -R / chown -R / chgrp -R' },
  // Copies and moves replace existing files only sometimes; asking for every one is noise.
  { id: 'copy-move', category: 'overwrite', name: 'cp / mv / Copy-Item / Move-Item', defaultMode: 'allow' },
  { id: 'disk-format', category: 'system', name: 'mkfs, wipefs, Format-Volume' },
  { id: 'power', category: 'system', name: 'shutdown, reboot, poweroff' },
  { id: 'package-remove', category: 'system', name: 'apt/dnf/yum/pacman/brew/snap/apk package removal' },
];
const ruleById = new Map(RULES.map(rule => [rule.id, rule]));

/** A destructive operation found in a call. targets is null when a target cannot be resolved. */
export interface Match { rule: string; targets: string[] | null }

interface Word { value: string; dynamic: boolean; quoted: boolean }
interface Segment { words: Word[]; redirects: Word[] }

/** Splits shell text into simple commands; quoted text stays inside its word. */
// On Windows targets backslash separates paths and backtick escapes (PowerShell).
function lex(text: string, windowsMode: boolean): { segments: Segment[]; nested: string[] } {
  const segments: Segment[] = []; const nested: string[] = [];
  let segment: Segment = { words: [], redirects: [] };
  let word = null as Word | null;
  let redirect = null as 'target' | 'skip' | null;
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  const endWord = () => {
    if (!word) return;
    if (redirect === 'target') segment.redirects.push(word);
    else if (redirect !== 'skip') segment.words.push(word);
    redirect = null; word = null;
  };
  const endSegment = () => {
    endWord(); redirect = null;
    if (segment.words.length || segment.redirects.length) segments.push(segment);
    segment = { words: [], redirects: [] };
  };
  const current = () => (word ??= { value: '', dynamic: false, quoted: false });
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      endSegment(); i++;
      // Here-document bodies are data, not commands.
      for (const doc of heredocs.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf('\n', i); const line = text.slice(i, end < 0 ? text.length : end);
          i = end < 0 ? text.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && !word) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === (windowsMode ? '`' : '\\') && i + 1 < text.length) {
      if (text[i + 1] === '\n') { i += 2; continue; }
      current().value += text[i + 1]; i += 2; continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1); const w = current();
      w.value += text.slice(i + 1, end < 0 ? text.length : end); w.quoted = true;
      i = end < 0 ? text.length : end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let value = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; } else value += text[j++]; }
      const w = current(); w.value += value; w.quoted = true;
      if (/[$`]/.test(value)) { w.dynamic = true; if (/\$\(|`/.test(value)) nested.push(value); }
      i = j + 1; continue;
    }
    if (c === '$' && text[i + 1] === '(') { current().dynamic = true; endSegment(); i += 2; continue; }
    if (c === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i); const w = current(); w.dynamic = true;
      w.value += text.slice(i, end < 0 ? text.length : end + 1); i = end < 0 ? text.length : end + 1; continue;
    }
    if (c === '$') { const w = current(); w.dynamic = true; w.value += c; i++; continue; }
    if (c === '`') { if (word) word.dynamic = true; endSegment(); i++; continue; }
    if (c === '~' && !word) { const w = current(); w.dynamic = true; w.value += c; i++; continue; }
    if (c === '&' && text[i + 1] === '>') {
      endWord(); const append = text[i + 2] === '>'; i += append ? 3 : 2; redirect = append ? 'skip' : 'target'; continue;
    }
    if (c === '>') {
      // A digit-only word right before > is a file descriptor, not an argument.
      if (word && /^\d+$/.test(word.value) && !word.quoted) word = null; else endWord();
      if (text[i + 1] === '>') { redirect = 'skip'; i += 2; continue; }
      if (text[i + 1] === '&') { redirect = 'skip'; i += 2; continue; }
      if (text[i + 1] === '(') { endSegment(); i += 2; continue; }
      redirect = 'target'; i += text[i + 1] === '|' ? 2 : 1; continue;
    }
    if (c === '<') {
      if (word && /^\d+$/.test(word.value) && !word.quoted) word = null; else endWord();
      if (text.startsWith('<<<', i)) { redirect = 'skip'; i += 3; continue; }
      if (text.startsWith('<<', i)) {
        const strip = text[i + 2] === '-'; i += strip ? 3 : 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        const match = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(text.slice(i));
        if (match) { heredocs.push({ delimiter: match[2], strip }); i += match[0].length; }
        continue;
      }
      if (text[i + 1] === '(') { endSegment(); i += 2; continue; }
      redirect = 'skip'; i++; continue;
    }
    if (';&|()'.includes(c)) { endSegment(); i++; continue; }
    current().value += c; i++;
  }
  endSegment();
  return { segments, nested };
}

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'exec', 'command', 'builtin', 'time', 'nice', 'ionice', 'timeout', 'xargs', 'stdbuf', 'setsid', 'runuser', 'chroot', 'busybox', 'strace', 'unbuffer', 'flock', 'parallel']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'eval', 'su', 'watch', 'ssh', 'pwsh', 'powershell', 'cmd', 'invoke-expression', 'iex', 'start-process']);
const CD = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl']);
const POWER = new Set(['shutdown', 'poweroff', 'halt', 'reboot', 'stop-computer', 'restart-computer']);
const FORMAT = new Set(['mkswap', 'wipefs', 'format-volume', 'clear-disk']);
const REMOVE_ITEM = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const NULL_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '$null', 'nul']);
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const commandName = (word: Word) => word.value.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
const PACKAGE_REMOVE: Record<string, (operands: string[], args: string[]) => boolean> = {
  apt: ops => ['remove', 'purge', 'autoremove'].includes(ops[0]), 'apt-get': ops => ['remove', 'purge', 'autoremove'].includes(ops[0]),
  dnf: ops => ['remove', 'erase', 'autoremove'].includes(ops[0]), yum: ops => ['remove', 'erase', 'autoremove'].includes(ops[0]),
  zypper: ops => ['remove', 'rm'].includes(ops[0]), brew: ops => ['uninstall', 'remove', 'rm'].includes(ops[0]),
  snap: ops => ops[0] === 'remove', apk: ops => ops[0] === 'del', pacman: (_ops, args) => args.some(arg => /^-R/.test(arg) || arg === '--remove'),
};
const COPY_MOVE = new Set(['cp', 'mv', 'copy-item', 'move-item', 'copy', 'move', 'cpi', 'mi']);
const KNOWN = new Set(['rm', 'unlink', 'find', 'shred', 'dd', 'truncate', 'clear-content', 'set-content', 'out-file', 'init', 'telinit', 'systemctl',
  'git', 'docker', 'podman', 'chmod', 'chown', 'chgrp', 'sed', 'perl', ...COPY_MOVE, ...Object.keys(PACKAGE_REMOVE), ...POWER, ...FORMAT, ...REMOVE_ITEM, ...SHELLS]);
const isKnown = (name: string) => KNOWN.has(name) || /^mkfs(\..+)?$/.test(name);
const options = (words: Word[]) => words.filter(word => word.quoted || !word.value.startsWith('-'));

interface Scope { cwd: string | null; remote: boolean; windows: boolean }

function analyzeSegment(words: Word[], redirects: Word[], scope: Scope, matches: Match[]) {
  const target = (list: Word[]): string[] | null => {
    if (scope.remote || list.some(word => word.dynamic)) return null;
    const resolved: string[] = [];
    for (const word of list) {
      // C:name is relative to that drive's own current directory.
      if (/^[A-Za-z]:(?![\\/])/.test(word.value)) return null;
      const absolute = isAbsolute(word.value);
      if (!absolute && !scope.cwd) return null;
      resolved.push(absolute ? word.value : join(scope.cwd!, word.value));
    }
    return resolved;
  };
  const written = redirects.filter(word => !NULL_DEVICES.has(word.value.toLowerCase()));
  if (written.length) matches.push({ rule: 'redirect', targets: target(written) });
  let index = words.findIndex(word => word.quoted || !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value) || KEYWORDS.has(word.value)));
  if (index < 0) return;
  let name = commandName(words[index]);
  if (WRAPPERS.has(name)) {
    const next = words.findIndex((word, position) => position > index && isKnown(commandName(word)));
    if (next < 0) return;
    index = next; name = commandName(words[index]);
  }
  const args = words.slice(index + 1);
  const operands = options(args);
  if (CD.has(name)) { scope.cwd = null; return; }
  if (SHELLS.has(name)) {
    const inner: Scope = { ...scope, remote: scope.remote || name === 'ssh' };
    for (const word of operands) analyzeText(word.value, inner, matches);
    return;
  }
  if (name === 'rm' || name === 'unlink') {
    const recursive = args.some(word => !word.quoted && (/^-[a-zA-Z]*[rR]/.test(word.value) || word.value === '--recursive'));
    matches.push({ rule: recursive ? 'rm-recursive' : 'rm', targets: target(operands) }); return;
  }
  if (name === 'find') {
    const exec = args.findIndex(word => ['-exec', '-execdir', '-ok', '-okdir'].includes(word.value));
    const deletes = args.some(word => word.value === '-delete') || (exec >= 0 && ['rm', 'unlink', 'shred'].includes(commandName(args[exec + 1] ?? { value: '', dynamic: false, quoted: false })));
    if (!deletes) return;
    const starts = args.slice(0, Math.max(0, args.findIndex(word => word.value.startsWith('-') || word.value === '!' || word.value === '(')));
    matches.push({ rule: 'find-delete', targets: target(starts.length ? starts : [{ value: '.', dynamic: false, quoted: false }]) }); return;
  }
  if (name === 'shred') { matches.push({ rule: 'shred', targets: target(operands) }); return; }
  if (REMOVE_ITEM.has(name)) { matches.push({ rule: 'remove-item', targets: target(operands) }); return; }
  if (name === 'truncate' || name === 'clear-content') {
    const files = args.filter((word, position) => !word.value.startsWith('-') && !['-s', '--size', '-r', '--reference'].includes(args[position - 1]?.value ?? ''));
    matches.push({ rule: 'truncate', targets: target(files) }); return;
  }
  if ((name === 'set-content' || name === 'out-file') && !args.some(word => /^-append$/i.test(word.value))) {
    matches.push({ rule: 'redirect', targets: target(operands) }); return;
  }
  if (name === 'dd') {
    const outputs = args.filter(word => word.value.startsWith('of='));
    if (outputs.length) matches.push({ rule: 'dd', targets: target(outputs.map(word => ({ ...word, value: word.value.slice(3) }))) });
    return;
  }
  if (/^mkfs(\..+)?$/.test(name) || FORMAT.has(name)) { matches.push({ rule: 'disk-format', targets: null }); return; }
  if (name === 'git') {
    // `git -C dir` runs in dir; the whole work tree is the target.
    const at = args.findIndex(word => word.value === '-C');
    const sub = args.findIndex((word, position) => !word.value.startsWith('-') && (at < 0 || position !== at + 1));
    const command = args[sub]?.value; const rest = args.slice(sub + 1).map(word => word.value);
    const discards = (command === 'reset' && rest.includes('--hard')) || (command === 'clean' && rest.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force'))
      || (command === 'checkout' && (rest.includes('--') || rest.includes('.') || rest.some(arg => /^-[a-zA-Z]*f$/.test(arg) || arg === '--force')))
      || (command === 'restore' && !(rest.includes('--staged') && !rest.includes('--worktree')));
    if (discards) matches.push({ rule: 'git-discard', targets: target([at >= 0 && args[at + 1] ? args[at + 1] : { value: '.', dynamic: false, quoted: false }]) });
    return;
  }
  if (name === 'docker' || name === 'podman') {
    const ops = operands.map(word => word.value);
    const removes = ['rm', 'rmi'].includes(ops[0]) || ops.includes('prune') || (['volume', 'container', 'image', 'network'].includes(ops[0]) && ['rm', 'remove'].includes(ops[1]))
      || ((ops[0] === 'compose' || name === 'podman' && ops[0] === 'compose') && ops.includes('down') && args.some(word => ['-v', '--volumes', '--rmi'].includes(word.value)));
    if (removes) matches.push({ rule: 'docker-remove', targets: null });
    return;
  }
  if (['chmod', 'chown', 'chgrp'].includes(name) && args.some(word => !word.quoted && (/^-[a-zA-Z]*R/.test(word.value) || word.value === '--recursive'))) {
    matches.push({ rule: 'permissions', targets: target(operands.slice(1)) }); return;
  }
  if ((name === 'sed' || name === 'perl') && args.some(word => !word.quoted && (/^-[a-zA-Z]*i/.test(word.value) || word.value.startsWith('--in-place')))) {
    // The script is the first operand unless given with -e/-f/-E.
    const scripted = args.some(word => ['-e', '-f', '-E', '--expression', '--file'].includes(word.value) || /^-[a-zA-Z]*[eE]$/.test(word.value) && name === 'perl');
    const files = args.filter((word, position) => (word.quoted || !word.value.startsWith('-')) && !['-e', '-f', '-E', '--expression', '--file'].includes(args[position - 1]?.value ?? '') && !(name === 'perl' && /^-[a-zA-Z]*e$/.test(args[position - 1]?.value ?? '')));
    matches.push({ rule: 'in-place-edit', targets: target(scripted ? files : files.slice(1)) }); return;
  }
  if (COPY_MOVE.has(name)) {
    const destination = operands.at(-1);
    if (operands.length >= 2 && destination) matches.push({ rule: 'copy-move', targets: target([destination]) });
    return;
  }
  if (PACKAGE_REMOVE[name]?.(operands.map(word => word.value), args.map(word => word.value))) { matches.push({ rule: 'package-remove', targets: null }); return; }
  if (POWER.has(name) || (['init', 'telinit'].includes(name) && ['0', '6'].includes(operands[0]?.value ?? ''))
    || (name === 'systemctl' && operands.some(word => ['poweroff', 'reboot', 'halt', 'kexec', 'soft-reboot'].includes(word.value)))) {
    matches.push({ rule: 'power', targets: null });
  }
}

export type MatchType = 'command' | 'regex';

/** Whether a simple command in text starts with the given words, including commands
 * after wrappers (sudo docker rm) and inside quoted scripts (bash -c "docker rm"). */
export function commandMatches(text: string, pattern: string[], windowsTarget: boolean, depth = 0): boolean {
  if (!pattern.length || depth > 3) return false;
  const same = (a: string, b: string) => windowsTarget ? a.toLowerCase() === b.toLowerCase() : a === b;
  const { segments, nested } = lex(text, windowsTarget);
  for (const { words } of segments) {
    for (let start = 0; start < words.length; start++) {
      if (commandName(words[start]) !== pattern[0].toLowerCase().replace(/\.exe$/, '')) continue;
      if (pattern.slice(1).every((part, offset) => words[start + 1 + offset] && same(words[start + 1 + offset].value, part))) return true;
    }
    for (const word of words) if (/\s/.test(word.value) && commandMatches(word.value, pattern, windowsTarget, depth + 1)) return true;
  }
  return nested.some(inner => commandMatches(inner, pattern, windowsTarget, depth + 1));
}

function analyzeText(text: string, scope: Scope, matches: Match[]) {
  const { segments, nested } = lex(text, scope.windows);
  for (const segment of segments) analyzeSegment(segment.words, segment.redirects, scope, matches);
  for (const inner of nested) analyzeText(inner, { ...scope }, matches);
}

/** Destructive operations in a shell command run from cwd (null when unknown). */
export function classifyCommand(cmd: string, cwd: string | null, windowsTarget = cwd !== null && windows(cwd)): Match[] {
  const matches: Match[] = [];
  analyzeText(cmd, { cwd, remote: false, windows: windowsTarget }, matches);
  return matches;
}

const windows = (value: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(value);
const isAbsolute = (value: string) => value.startsWith('/') || windows(value);
const join = (cwd: string, value: string) => windows(cwd) ? path.win32.resolve(cwd, value) : path.posix.resolve(cwd, value);
export function normalizeFolder(value: string) {
  const normalized = windows(value) ? path.win32.resolve(value) : path.posix.resolve(value);
  if (normalized === '/' || /^[A-Za-z]:\\?$/.test(normalized) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) {
    throw new AppError('INVALID_FOLDER', 'A filesystem root cannot be an allowed folder. To allow every location, set the rule to Allow.');
  }
  return normalized.length > 1 ? normalized.replace(/[\\/]$/, '') : normalized;
}
function inside(folder: string, target: string) {
  if (windows(folder) !== windows(target)) return false;
  const api = windows(folder) ? path.win32 : path.posix;
  const fold = (value: string) => windows(folder) ? value.toLowerCase() : value;
  const relative = api.relative(fold(folder), fold(api.resolve(target)));
  return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
}

export interface ApprovalRecord {
  id: string; serverId: string; serverName: string | null; tool: string; command: string; path: string | null;
  rules: string[]; status: 'pending' | 'approved' | 'denied' | 'blocked' | 'expired';
  clientId: string | null; createdAt: string; decidedAt: string | null; expiresAt: string | null; usedAt: string | null;
  ruleNames?: string[];
}
interface ApprovalRow {
  id: string; server_id: string; server_name: string | null; tool: string; command: string; path: string | null; rules: string;
  status: ApprovalRecord['status']; client_id: string | null; created_at: string; decided_at: string | null; expires_at: string | null; used_at: string | null;
}
const fromRow = (row: ApprovalRow): ApprovalRecord => ({
  id: row.id, serverId: row.server_id, serverName: row.server_name, tool: row.tool, command: row.command, path: row.path,
  rules: JSON.parse(row.rules), status: row.status, clientId: row.client_id, createdAt: row.created_at,
  decidedAt: row.decided_at, expiresAt: row.expires_at, usedAt: row.used_at,
});
export interface Folder { id: string; serverId: string | null; path: string; createdAt: string }
export interface CustomRule { id: string; name: string; matchType: MatchType; pattern: string; mode: RuleMode; createdAt: string }
const CUSTOM_PREFIX = 'custom-';

/** Validates a user rule's pattern; command patterns are 1–8 words. */
export function parseCustomPattern(matchType: MatchType, pattern: string): string[] | RegExp {
  const value = pattern.trim();
  if (!value) throw new AppError('RULE_PATTERN_REQUIRED', 'Enter a rule pattern.');
  if (matchType === 'regex') {
    try { return new RegExp(value, 'i'); } catch (error) { const detail = error instanceof Error ? error.message : '';
      throw new AppError('INVALID_RULE_REGEX', 'The regular expression is invalid: ' + detail, 400, { detail }); }
  }
  const words = value.split(/\s+/);
  if (words.length > 8) throw new AppError('RULE_TOO_MANY_WORDS', 'A command pattern can have at most 8 words.', 400, { max: 8 });
  return words;
}
export interface CheckInput {
  serverId: string; tool: string; command: string; path?: string | null;
  /** Arguments that must match exactly for an approval to be used. */
  args: unknown; matches: Match[]; clientId?: string | null;
}
export type CheckResult =
  | { ok: true }
  | { ok: false; code: 'APPROVAL_REQUIRED' | 'APPROVAL_DENIED' | 'COMMAND_BLOCKED'; approvalId: string; rules: string[] };

const PENDING_MS = 60 * 60_000;
const APPROVED_MS = 30 * 60_000;

/** Emits 'approvals' on the store when requests, rules or folders change. */
export class Approvals {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS command_rules (rule_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allowed_folders (id TEXT PRIMARY KEY, server_id TEXT, path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS custom_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, match_type TEXT NOT NULL, pattern TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, server_id TEXT NOT NULL, tool TEXT NOT NULL, command TEXT NOT NULL, path TEXT,
        rules TEXT NOT NULL, status TEXT NOT NULL, client_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT, used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_fingerprint ON approvals(fingerprint, status);
      CREATE INDEX IF NOT EXISTS approvals_created ON approvals(created_at);
    `);
  }
  private changed() { this.store.emit('approvals'); }
  /** Master switch: while off, no rule asks or blocks. */
  enabled() { return this.store.setting('approvalsEnabled') !== 'false'; }
  setEnabled(enabled: boolean) {
    this.store.setSetting('approvalsEnabled', String(enabled));
    this.changed();
  }
  private named(record: ApprovalRecord): ApprovalRecord { return { ...record, ruleNames: this.ruleNames(record.rules) }; }
  customRules(): CustomRule[] {
    return this.store.db.prepare('SELECT id, name, match_type matchType, pattern, mode, created_at createdAt FROM custom_rules ORDER BY created_at').all() as CustomRule[];
  }
  rules() {
    const saved = new Map((this.store.db.prepare('SELECT rule_id, mode, updated_at FROM command_rules').all() as { rule_id: string; mode: RuleMode; updated_at: string }[]).map(row => [row.rule_id, row]));
    const builtIn = RULES.map(rule => ({ ...rule, mode: saved.get(rule.id)?.mode ?? rule.defaultMode ?? 'confirm' as RuleMode, updatedAt: saved.get(rule.id)?.updated_at ?? null }));
    const custom = (this.store.db.prepare('SELECT * FROM custom_rules ORDER BY created_at').all() as { id: string; name: string; match_type: MatchType; pattern: string; mode: RuleMode; updated_at: string | null }[])
      .map(row => ({ id: row.id, category: 'custom' as RuleCategory, name: row.name, mode: row.mode, updatedAt: row.updated_at, matchType: row.match_type, pattern: row.pattern }));
    return [...builtIn, ...custom];
  }
  /** User rules ask for approval or block; they never allow what a built-in rule asks about. */
  addCustomRule(input: { name: string; matchType: MatchType; pattern: string; mode: RuleMode }): CustomRule {
    if (input.mode === 'allow') throw new AppError('CUSTOM_RULE_MODE_INVALID', 'Custom rules can only ask for approval or block.');
    parseCustomPattern(input.matchType, input.pattern);
    const rule: CustomRule = { id: CUSTOM_PREFIX + randomUUID(), name: input.name.trim(), matchType: input.matchType, pattern: input.pattern.trim(), mode: input.mode, createdAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO custom_rules (id,name,match_type,pattern,mode,created_at) VALUES (?,?,?,?,?,?)').run(rule.id, rule.name, rule.matchType, rule.pattern, rule.mode, rule.createdAt);
    this.changed();
    return rule;
  }
  removeCustomRule(id: string) {
    if (!this.store.db.prepare('DELETE FROM custom_rules WHERE id=?').run(id).changes) throw new AppError('RULE_NOT_FOUND', 'Rule not found.', 404);
    this.changed();
  }
  /** User rules matching a shell command or job input. */
  customMatches(command: string, windowsTarget: boolean): Match[] {
    const matches: Match[] = [];
    for (const rule of this.customRules()) {
      const pattern = parseCustomPattern(rule.matchType, rule.pattern);
      const hit = pattern instanceof RegExp ? pattern.test(command) : commandMatches(command, pattern, windowsTarget);
      if (hit) matches.push({ rule: rule.id, targets: null });
    }
    return matches;
  }
  /** Display names for built-in and user rule IDs. */
  ruleNames(ids: string[]) {
    const custom = new Map(this.customRules().map(rule => [rule.id, rule.name]));
    return ids.map(id => custom.get(id) ?? ruleById.get(id)?.name ?? id);
  }
  setRule(id: string, mode: RuleMode) {
    if (id.startsWith(CUSTOM_PREFIX)) {
      if (mode === 'allow') throw new AppError('CUSTOM_RULE_MODE_INVALID', 'Custom rules can only ask for approval or block.');
      if (!this.store.db.prepare('UPDATE custom_rules SET mode=?, updated_at=? WHERE id=?').run(mode, new Date().toISOString(), id).changes) throw new AppError('RULE_NOT_FOUND', 'Rule not found.', 404);
      this.changed();
      return;
    }
    if (!ruleById.has(id)) throw new AppError('RULE_NOT_FOUND', 'Rule not found.', 404);
    this.store.db.prepare('INSERT INTO command_rules VALUES (?,?,?) ON CONFLICT(rule_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at').run(id, mode, new Date().toISOString());
    this.changed();
  }
  folders(): Folder[] {
    return this.store.db.prepare('SELECT id, server_id serverId, path, created_at createdAt FROM allowed_folders ORDER BY path').all() as Folder[];
  }
  addFolder(serverId: string | null, folder: string): Folder {
    if (serverId) this.store.server(serverId);
    const record = { id: randomUUID(), serverId, path: normalizeFolder(folder), createdAt: new Date().toISOString() };
    const duplicate = this.folders().some(item => item.serverId === serverId && item.path === record.path);
    if (duplicate) throw new AppError('DUPLICATE_FOLDER', 'This allowed folder is already registered.', 409);
    this.store.db.prepare('INSERT INTO allowed_folders VALUES (?,?,?,?)').run(record.id, serverId, record.path, record.createdAt);
    this.changed();
    return record;
  }
  removeFolder(id: string) {
    if (!this.store.db.prepare('DELETE FROM allowed_folders WHERE id=?').run(id).changes) throw new AppError('FOLDER_NOT_FOUND', 'Allowed folder not found.', 404);
    this.changed();
  }
  /** Rules that still need a decision after rule modes and allowed folders apply. */
  evaluate(serverId: string, matches: Match[]): { block: string[]; confirm: string[] } {
    const modes = new Map(this.rules().map(rule => [rule.id, rule.mode]));
    const folders = this.folders().filter(folder => folder.serverId === null || folder.serverId === serverId).map(folder => folder.path);
    const block = new Set<string>(); const confirm = new Set<string>();
    for (const match of matches) {
      const mode = modes.get(match.rule) ?? 'confirm';
      if (mode === 'block') { block.add(match.rule); continue; }
      if (mode === 'allow') continue;
      const category = ruleById.get(match.rule)?.category ?? 'custom';
      const exempt = (category === 'delete' || category === 'overwrite') && match.targets !== null && match.targets.length > 0
        && match.targets.every(target => folders.some(folder => inside(folder, target)));
      if (!exempt) confirm.add(match.rule);
    }
    return { block: [...block], confirm: [...confirm] };
  }
  private expire(now = new Date().toISOString()) {
    this.store.db.prepare("UPDATE approvals SET status='expired' WHERE expires_at<? AND (status='pending' OR (status='approved' AND used_at IS NULL))").run(now);
  }
  check(input: CheckInput): CheckResult {
    if (!input.matches.length || !this.enabled()) return { ok: true };
    const { block, confirm } = this.evaluate(input.serverId, input.matches);
    if (!block.length && !confirm.length) return { ok: true };
    const now = new Date().toISOString();
    const command = redactText(input.command).slice(0, 4000);
    const insert = (status: 'pending' | 'blocked', rules: string[]) => {
      const id = randomUUID();
      this.store.db.prepare(`INSERT INTO approvals (id,fingerprint,server_id,tool,command,path,rules,status,client_id,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, fingerprint, input.serverId, input.tool, command, input.path ?? null, JSON.stringify(rules), status, input.clientId ?? null, now,
        status === 'pending' ? new Date(Date.now() + PENDING_MS).toISOString() : null);
      this.changed();
      // Announced after the surrounding transaction commits (notifications).
      if (status === 'pending') setImmediate(() => this.store.emit('approval-request', id));
      return id;
    };
    const fingerprint = hash(JSON.stringify({ serverId: input.serverId, tool: input.tool, args: input.args }));
    if (block.length) return { ok: false, code: 'COMMAND_BLOCKED', approvalId: insert('blocked', block), rules: block };
    return this.store.db.transaction((): CheckResult => {
      this.expire(now);
      const row = this.store.db.prepare(`SELECT id, status FROM approvals WHERE fingerprint=? AND used_at IS NULL AND status IN ('pending','approved','denied')
        ORDER BY created_at DESC LIMIT 1`).get(fingerprint) as { id: string; status: string } | undefined;
      if (row?.status === 'pending') return { ok: false, code: 'APPROVAL_REQUIRED', approvalId: row.id, rules: confirm };
      if (row) {
        // An approval or denial answers exactly one retry of the same call.
        this.store.db.prepare('UPDATE approvals SET used_at=? WHERE id=?').run(now, row.id);
        this.changed();
        return row.status === 'approved' ? { ok: true } : { ok: false, code: 'APPROVAL_DENIED', approvalId: row.id, rules: confirm };
      }
      return { ok: false, code: 'APPROVAL_REQUIRED', approvalId: insert('pending', confirm), rules: confirm };
    })();
  }
  decide(id: string, decision: 'approve' | 'deny', always = false): ApprovalRecord {
    this.expire();
    const record = this.get(id);
    if (record.status !== 'pending') throw new AppError('NOT_PENDING', 'This request was already decided or has expired.', 409);
    const now = new Date();
    this.store.db.transaction(() => {
      this.store.db.prepare('UPDATE approvals SET status=?, decided_at=?, expires_at=? WHERE id=?')
        .run(decision === 'approve' ? 'approved' : 'denied', now.toISOString(), new Date(now.getTime() + APPROVED_MS).toISOString(), id);
      // A user rule cannot be set to allow; approving it always is not offered.
      if (always) for (const rule of record.rules) if (!(decision === 'approve' && rule.startsWith(CUSTOM_PREFIX))) this.setRule(rule, decision === 'approve' ? 'allow' : 'block');
    })();
    this.changed();
    return this.get(id);
  }
  get(id: string): ApprovalRecord {
    const row = this.store.db.prepare('SELECT a.*, s.name server_name FROM approvals a LEFT JOIN servers s ON s.id=a.server_id WHERE a.id=?').get(id) as ApprovalRow | undefined;
    if (!row) throw new AppError('APPROVAL_NOT_FOUND', 'Approval request not found.', 404);
    return this.named(fromRow(row));
  }
  list(query: { status?: ApprovalRecord['status']; limit: number; offset: number }) {
    this.expire();
    const where = query.status ? 'WHERE a.status=?' : '';
    const params = query.status ? [query.status] : [];
    const total = (this.store.db.prepare(`SELECT count(*) n FROM approvals a ${where}`).get(...params) as { n: number }).n;
    const rows = this.store.db.prepare(`SELECT a.*, s.name server_name FROM approvals a LEFT JOIN servers s ON s.id=a.server_id ${where}
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, query.limit, query.offset) as ApprovalRow[];
    const pending = (this.store.db.prepare("SELECT count(*) n FROM approvals WHERE status='pending'").get() as { n: number }).n;
    return { items: rows.map(row => this.named(fromRow(row))), total, pending };
  }
  cleanup(now = Date.now()) {
    this.expire(new Date(now).toISOString());
    this.store.db.prepare("DELETE FROM approvals WHERE status<>'pending' AND created_at<?").run(new Date(now - 30 * 86400_000).toISOString());
  }
}

export const ruleNames = (ids: string[]) => ids.map(id => ruleById.get(id)?.name ?? id);
