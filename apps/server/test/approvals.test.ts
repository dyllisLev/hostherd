import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { classifyCommand, normalizeFolder } from '../src/approvals.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const rules = (cmd: string, cwd: string | null = '/p') => classifyCommand(cmd, cwd).map(match => match.rule);

test('command analysis finds delete, overwrite and shutdown operations and their targets', () => {
  assert.deepEqual(classifyCommand('rm -rf ./node_modules dist', '/home/u/proj'), [{ rule: 'rm-recursive', targets: ['/home/u/proj/node_modules', '/home/u/proj/dist'] }]);
  assert.deepEqual(rules('rm a.txt'), ['rm']);
  assert.deepEqual(rules('find . -name "*.tmp" -delete'), ['find-delete']);
  assert.deepEqual(rules('find /var -exec rm {} \\;'), ['find-delete']);
  assert.deepEqual(rules('echo hi > out.txt; cat a >> log'), ['redirect']);
  assert.deepEqual(rules('make 2>&1 > /dev/null; ls 2>/dev/null'), []);
  assert.deepEqual(rules('dd if=/dev/zero of=disk.img bs=1M'), ['dd']);
  assert.deepEqual(rules('sudo shutdown -h now'), ['power']);
  assert.deepEqual(rules('systemctl reboot'), ['power']);
  assert.deepEqual(rules('mkfs.ext4 /dev/sdb1'), ['disk-format']);
  assert.deepEqual(rules('bash -c "rm -rf /x"'), ['rm-recursive']);
  assert.deepEqual(rules('echo $(rm -rf /x)'), ['rm-recursive']);
  assert.deepEqual(rules('xargs -n 1 rm < list'), ['rm']);
  // Arguments and here-document bodies are data, not commands.
  assert.deepEqual(rules('grep shutdown /var/log/syslog; git commit -m "a > b"; echo "rm -rf /"'), []);
  assert.deepEqual(rules('cat > f.sh <<EOF\nrm -rf /\nEOF\nls'), ['redirect']);
  // Unknown locations are not placed in any folder.
  assert.equal(classifyCommand('cd /etc && rm -rf x', '/p')[0].targets, null);
  assert.equal(classifyCommand('rm -rf $HOME/x', '/p')[0].targets, null);
  assert.equal(classifyCommand('rm -rf ~/x', '/p')[0].targets, null);
  assert.equal(classifyCommand('ssh host "rm -rf /tmp"', '/p')[0].targets, null);
  assert.deepEqual(classifyCommand('Remove-Item .\\build -Recurse', 'C:\\proj'), [{ rule: 'remove-item', targets: ['C:\\proj\\build'] }]);
  assert.deepEqual(classifyCommand('Remove-Item C:\\Windows\\System32 -Recurse', 'C:\\proj')[0].targets, ['C:\\Windows\\System32']);
  assert.deepEqual(rules('Get-Process | Out-File C:\\proj\\p.txt; ls 2>$null', 'C:\\proj'), ['redirect']);
  assert.equal(normalizeFolder('/home/u/proj/'), '/home/u/proj');
  assert.equal(normalizeFolder('C:\\Proj\\'), 'C:\\Proj');
  assert.throws(() => normalizeFolder('/'), { code: 'INVALID_FOLDER' });
  assert.throws(() => normalizeFolder('C:\\'), { code: 'INVALID_FOLDER' });
});

test('MCP destructive calls wait for web approval, follow rule modes and allowed folders', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-approvals-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const web = async <T = unknown>(method: string, url: string, body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const pat = (await web<{ token: string }>('POST', '/api/tokens', { name: 'approvals' })).body;
  const { code } = app.store.enrollment('Approval target');
  const enrolled = await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' }) });
  const credentials = await enrolled.json() as { token: string; serverId: string };
  const serverId = credentials.serverId;
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${credentials.token}` } });
  const calls: { method: string; params: { cmd?: string; path?: string } }[] = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'request') return;
    calls.push({ method: m.method, params: m.params });
    let result: unknown = { ok: true };
    if (m.method === 'file.list' && m.params.path === '/locked') { ws.send(JSON.stringify({ type: 'response', id: m.id, error: { code: 'permission_denied', message: 'permission denied' } })); return; }
    if (m.method === 'file.list') result = { entries: [{ name: 'existing.txt', type: 'file', size: 1, mode: 420, modifiedAt: new Date().toISOString() }, { name: 'app', type: 'directory', size: 0, mode: 493, modifiedAt: new Date().toISOString() }] };
    if (m.method === 'job.start') {
      result = { id: m.params.id, kind: 'job', path: m.params.path, cmd: m.params.cmd, status: 'running', startedAt: new Date().toISOString(), runnerVersion: '0.1.0' };
      ws.send(JSON.stringify({ type: 'state', job: result }));
    }
    ws.send(JSON.stringify({ type: 'response', id: m.id, result }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', user: 'root' }));
  for (let i = 0; i < 100 && !app.hub.online(serverId); i++) await sleep(20);
  const client = new Client({ name: 'approval-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pat.token}` } } }));
  t.after(() => client.close());
  assert.match(client.getInstructions()!, /APPROVAL_REQUIRED/);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
  };
  const starts = () => calls.filter(c => c.method === 'job.start').map(c => c.params.cmd);

  // Ordinary commands run immediately.
  assert.equal((await call('job_start', { serverId, path: '/', cmd: 'ls -la', waitMs: 0 })).isError, false);

  // Folder pickers list only subdirectories, read through the agent.
  const listed = await web<{ path: string; parent: string | null; directories: { name: string; path: string }[] }>('GET', `/api/servers/${serverId}/directories?path=${encodeURIComponent('/srv')}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { path: '/srv', parent: '/', directories: [{ name: 'app', path: '/srv/app' }] });

  // A destructive command is held until the user approves it in the web console.
  const request = { serverId, path: '/', cmd: 'rm -rf /srv/data', requestId: randomUUID(), waitMs: 0 };
  const held = await call('job_start', request);
  assert.equal(held.isError, true);
  assert.equal(held.body.code, 'APPROVAL_REQUIRED');
  assert.equal(held.body.approvalUrl, `http://localhost:3000/approvals/${held.body.approvalId}`);
  assert.deepEqual(held.body.rules, ['rm -r (recursive delete)']);
  assert.equal((await call('job_start', request)).body.approvalId, held.body.approvalId, 'a retry while pending reuses the request');
  assert.deepEqual(starts(), ['ls -la']);
  const pending = await web<{ items: { id: string; command: string; status: string; rules: string[]; serverName: string }[]; pending: number }>('GET', '/api/approvals?status=pending');
  assert.equal(pending.body.pending, 1);
  assert.deepEqual(pending.body.items.map(item => [item.id, item.command, item.rules, item.serverName]), [[held.body.approvalId, 'rm -rf /srv/data', ['rm-recursive'], 'Approval target']]);
  assert.equal((await web<{ status: string }>('POST', `/api/approvals/${held.body.approvalId}/decision`, { decision: 'approve' })).body.status, 'approved');
  assert.equal((await web('POST', `/api/approvals/${held.body.approvalId}/decision`, { decision: 'deny' })).status, 409);
  assert.equal((await call('job_start', request)).isError, false);
  assert.deepEqual(starts(), ['ls -la', 'rm -rf /srv/data']);
  // An uncertain retry with the dispatched requestId returns the same job without asking again.
  assert.equal((await call('job_start', request)).isError, false);
  assert.equal(starts().length, 2);
  // The approval was used once; running it again needs a new approval.
  assert.equal((await call('job_start', { ...request, requestId: randomUUID() })).body.code, 'APPROVAL_REQUIRED');

  // A denial answers the retry once and nothing runs.
  const denied = await call('job_start', { serverId, path: '/', cmd: 'shred secret.key', waitMs: 0 });
  await web('POST', `/api/approvals/${denied.body.approvalId}/decision`, { decision: 'deny' });
  assert.equal((await call('job_start', { serverId, path: '/', cmd: 'shred secret.key', waitMs: 0 })).body.code, 'APPROVAL_DENIED');
  assert.equal(starts().length, 2);

  // "Always allow" stores the rule; later commands of that kind run without asking.
  const finder = await call('job_start', { serverId, path: '/var/tmp', cmd: 'find . -name "*.log" -delete', waitMs: 0 });
  await web('POST', `/api/approvals/${finder.body.approvalId}/decision`, { decision: 'approve', always: true });
  assert.equal((await call('job_start', { serverId, path: '/var/tmp', cmd: 'find . -name "*.log" -delete', waitMs: 0 })).isError, false);
  assert.equal((await call('job_start', { serverId, path: '/opt', cmd: 'find /opt/cache -delete', waitMs: 0 })).isError, false);
  const ruleList = await web<{ id: string; mode: string }[]>('GET', '/api/command-rules');
  assert.equal(ruleList.body.find(rule => rule.id === 'find-delete')!.mode, 'allow');

  // Blocked rules never run and are recorded.
  await web('PUT', '/api/command-rules/power', { mode: 'block' });
  const blocked = await call('job_start', { serverId, path: '/', cmd: 'sudo reboot', waitMs: 0 });
  assert.equal(blocked.body.code, 'COMMAND_BLOCKED');
  assert.equal(blocked.body.approvalUrl, undefined);
  assert.equal((await web<{ items: { status: string }[] }>('GET', '/api/approvals?status=blocked')).body.items.length, 1);
  assert.ok(!starts().includes('sudo reboot'));
  assert.equal((await web('PUT', '/api/command-rules/unknown', { mode: 'allow' })).status, 404);

  // Inside an allowed folder, deletes and overwrites run; anything reaching outside still asks.
  assert.equal((await web('POST', '/api/allowed-folders', { serverId, path: '/' })).status, 400);
  const folder = await web<{ id: string; path: string }>('POST', '/api/allowed-folders', { serverId, path: '/home/u/proj/' });
  assert.equal(folder.status, 201);
  assert.equal(folder.body.path, '/home/u/proj');
  assert.equal((await web('POST', '/api/allowed-folders', { serverId, path: '/home/u/proj' })).status, 409);
  assert.equal((await call('job_start', { serverId, path: '/home/u/proj', cmd: 'rm -rf dist build && npm run build > build.log', waitMs: 0 })).isError, false);
  assert.equal((await call('job_start', { serverId, path: '/home/u/proj', cmd: 'rm -rf ../other', waitMs: 0 })).body.code, 'APPROVAL_REQUIRED');
  assert.equal((await call('job_start', { serverId, path: '/home/u/proj', cmd: 'cd /etc && rm x', waitMs: 0 })).body.code, 'APPROVAL_REQUIRED');
  assert.equal((await call('job_start', { serverId, path: '/home/u/proj', cmd: 'rm -rf /home/u/project2', waitMs: 0 })).body.code, 'APPROVAL_REQUIRED');
  assert.equal((await call('file_delete', { serverId, path: '/home/u/proj/tmp', recursive: true })).isError, false);
  assert.equal((await call('file_delete', { serverId, path: '/etc/hosts' })).body.code, 'APPROVAL_REQUIRED');

  // file_write asks only when it would replace an existing file outside the folders.
  assert.equal((await call('file_write', { serverId, path: '/etc/new.txt', data: 'x' })).isError, false);
  assert.equal((await call('file_write', { serverId, path: '/etc/existing.txt', data: 'x', createOnly: true })).isError, false);
  assert.equal((await call('file_write', { serverId, path: '/etc/existing.txt', data: 'x' })).body.code, 'APPROVAL_REQUIRED');
  assert.equal((await call('file_write', { serverId, path: '/home/u/proj/existing.txt', data: 'x' })).isError, false);
  // A parent that cannot be listed may hold the file, so the overwrite rule applies.
  assert.equal((await call('file_write', { serverId, path: '/locked/a.txt', data: 'x' })).body.code, 'APPROVAL_REQUIRED');
  // file_edit follows the in-place edit rule and its allowed folders.
  const edit = await call('file_edit', { serverId, path: '/etc/hosts', oldText: 'a', newText: 'b' });
  assert.equal(edit.body.code, 'APPROVAL_REQUIRED');
  assert.deepEqual(edit.body.rules, ['sed -i / perl -i / file_edit']);
  assert.equal((await call('file_edit', { serverId, path: '/home/u/proj/app.conf', oldText: 'a', newText: 'b' })).isError, false);
  assert.ok(!calls.some(c => c.method === 'file.edit' && c.params.path === '/etc/hosts'));
  assert.equal((await web('DELETE', `/api/allowed-folders/${folder.body.id}`)).status, 200);
  assert.equal((await call('file_write', { serverId, path: '/home/u/proj/existing.txt', data: 'x' })).body.code, 'APPROVAL_REQUIRED');
});

test('command prefixes match after wrappers and inside shell scripts, not as arguments elsewhere', async () => {
  const { commandMatches } = await import('../src/approvals.js');
  assert.equal(commandMatches('docker rm -f web', ['docker', 'rm'], false), true);
  assert.equal(commandMatches('sudo docker rm web', ['docker', 'rm'], false), true);
  assert.equal(commandMatches('bash -c "cd /srv && docker rm web"', ['docker', 'rm'], false), true);
  assert.equal(commandMatches('docker ps; docker run rm', ['docker', 'rm'], false), false);
  assert.equal(commandMatches('/usr/bin/kubectl delete pod x', ['kubectl', 'delete'], false), true);
  assert.equal(commandMatches('Stop-Service Spooler', ['stop-service'], true), true);
  assert.equal(commandMatches('DOCKER RM x', ['docker', 'rm'], false), false, 'arguments are case-sensitive outside Windows');
});

test('user rules ask or block matching commands, cannot allow, and show their names', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-custom-rules-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000', eventKeepAliveMs: 100 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const events = new AbortController();
  t.after(async () => { events.abort(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const web = async <T = unknown>(method: string, url: string, body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };

  // An event stream with only the session cookie (browsers send no Origin) survives keep-alive checks.
  const stream = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: events.signal });
  const reader = stream.body!.getReader(); let received = '';
  while ((received.match(/: ping/g) ?? []).length < 2) received += new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(received, /unauthorized/);

  assert.equal((await web('POST', '/api/command-rules', { name: 'x', matchType: 'command', pattern: 'docker rm', mode: 'allow' })).status, 400);
  const badRegex = await web<{ code: string; error: string; params: { detail: string } }>('POST', '/api/command-rules', { name: 'x', matchType: 'regex', pattern: '(', mode: 'confirm' });
  assert.equal(badRegex.status, 400);
  assert.equal(badRegex.body.code, 'INVALID_RULE_REGEX');
  assert.ok(badRegex.body.params.detail && badRegex.body.error.endsWith(badRegex.body.params.detail), 'the regex detail is a structured parameter');
  assert.deepEqual(await web('POST', '/api/command-rules', { name: 'x', matchType: 'command', pattern: 'a b c d e f g h i', mode: 'confirm' }),
    { status: 400, body: { code: 'RULE_TOO_MANY_WORDS', error: 'A command pattern can have at most 8 words.', params: { max: 8 } } });
  assert.deepEqual(await web('DELETE', '/api/command-rules/custom-missing'), { status: 404, body: { code: 'RULE_NOT_FOUND', error: 'Rule not found.' } });
  assert.deepEqual(await web('POST', '/api/allowed-folders', { path: 'relative/dir' }), { status: 400, body: { code: 'ABSOLUTE_PATH_REQUIRED', error: 'Enter an absolute path.' } });
  assert.deepEqual(await web('GET', '/api/no-such-route'), { status: 404, body: { code: 'API_NOT_FOUND', error: 'API endpoint not found.' } });
  const confirm = (await web<{ id: string }>('POST', '/api/command-rules', { name: '컨테이너 삭제', matchType: 'command', pattern: 'docker rm', mode: 'confirm' })).body;
  const block = (await web<{ id: string }>('POST', '/api/command-rules', { name: '강제 푸시', matchType: 'regex', pattern: 'git\\s+push\\s+.*--force', mode: 'block' })).body;
  const list = (await web<{ id: string; category: string; pattern?: string }[]>('GET', '/api/command-rules')).body;
  assert.deepEqual(list.filter(rule => rule.category === 'custom').map(rule => rule.pattern), ['docker rm', 'git\\s+push\\s+.*--force']);
  assert.deepEqual(await web('PUT', `/api/command-rules/${confirm.id}`, { mode: 'allow' }),
    { status: 400, body: { code: 'CUSTOM_RULE_MODE_INVALID', error: 'Custom rules can only ask for approval or block.' } });

  const blocked = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'git push origin main --force', args: {}, matches: app.approvals.customMatches('git push origin main --force', false) });
  assert.equal(blocked.ok, false); assert.equal(!blocked.ok && blocked.code, 'COMMAND_BLOCKED');
  const asked = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'sudo docker rm web', args: { n: 1 }, matches: app.approvals.customMatches('sudo docker rm web', false) });
  assert.equal(!asked.ok && asked.code, 'APPROVAL_REQUIRED');
  const record = app.approvals.get(!asked.ok ? asked.approvalId : '');
  assert.deepEqual(record.ruleNames, ['컨테이너 삭제']);
  // "Always approve" cannot turn a user rule into allow; the request is approved once.
  app.approvals.decide(record.id, 'approve', true);
  assert.equal(app.approvals.rules().find(rule => rule.id === confirm.id)?.mode, 'confirm');
  assert.equal(app.approvals.customMatches('docker ps', false).length, 0);

  // The master switch turns every rule off, block rules included.
  assert.deepEqual((await web('GET', '/api/approval-settings')).body, { enabled: true });
  assert.deepEqual((await web('PUT', '/api/approval-settings', { enabled: false })).body, { enabled: false });
  const unasked = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'docker rm db', args: { n: 2 }, matches: app.approvals.customMatches('docker rm db', false) });
  assert.equal(unasked.ok, true);
  const unblocked = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'git push origin main --force', args: { n: 3 }, matches: app.approvals.customMatches('git push origin main --force', false) });
  assert.equal(unblocked.ok, true);
  assert.deepEqual((await web('PUT', '/api/approval-settings', { enabled: true })).body, { enabled: true });
  const askedAgain = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'docker rm db', args: { n: 4 }, matches: app.approvals.customMatches('docker rm db', false) });
  assert.equal(!askedAgain.ok && askedAgain.code, 'APPROVAL_REQUIRED');
  const blockedAgain = app.approvals.check({ serverId: 's', tool: 'job_start', command: 'git push origin main --force', args: { n: 5 }, matches: app.approvals.customMatches('git push origin main --force', false) });
  assert.equal(!blockedAgain.ok && blockedAgain.code, 'COMMAND_BLOCKED');

  assert.equal((await web('DELETE', `/api/command-rules/${block.id}`)).status, 200);
  assert.equal(app.approvals.customMatches('git push --force', false).length, 0);
});

test('extended rules cover git discards, docker removal, recursive permissions, in-place edits, copies and package removal', () => {
  const rules = (cmd: string) => classifyCommand(cmd, '/p').map(match => match.rule);
  assert.deepEqual(rules('git reset --hard HEAD~1; git clean -fdx; git checkout -- src; git restore a.txt'), ['git-discard', 'git-discard', 'git-discard', 'git-discard']);
  assert.deepEqual(rules('git status; git checkout main; git restore --staged a; git commit -m "reset --hard"'), []);
  assert.deepEqual(classifyCommand('git -C /srv/app clean -fd', '/p'), [{ rule: 'git-discard', targets: ['/srv/app'] }]);
  assert.deepEqual(rules('docker rm -f web; docker system prune -af; docker volume rm data; docker compose down -v'), ['docker-remove', 'docker-remove', 'docker-remove', 'docker-remove']);
  assert.deepEqual(rules('docker ps; docker compose down; docker compose up -d'), []);
  assert.deepEqual(classifyCommand('sudo chown -R www:www /var/www', '/p'), [{ rule: 'permissions', targets: ['/var/www'] }]);
  assert.deepEqual(rules('chmod 644 a'), []);
  assert.deepEqual(classifyCommand("sed -i 's/a/b/' conf.txt", '/p'), [{ rule: 'in-place-edit', targets: ['/p/conf.txt'] }]);
  assert.deepEqual(classifyCommand("perl -pi -e 's/a/b/' f", '/p'), [{ rule: 'in-place-edit', targets: ['/p/f'] }]);
  assert.deepEqual(rules("sed 's/a/b/' f"), []);
  assert.deepEqual(classifyCommand('mv -f src/ dest/', '/p'), [{ rule: 'copy-move', targets: ['/p/dest'] }]);
  assert.deepEqual(rules('sudo apt remove nginx; apt-get -y purge x; pacman -Rns foo; brew uninstall git'), ['package-remove', 'package-remove', 'package-remove', 'package-remove']);
  assert.deepEqual(rules('apt install nginx; dnf install x'), []);
});

test('clients that support elicitation decide destructive commands in place; others keep the approval link', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-elicit-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const pat = await (await fetch(`${base}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'elicit' }) })).json() as { token: string };
  const { code } = app.store.enrollment('target');
  const { serverId, token } = await (await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' }) })).json() as { serverId: string; token: string };
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${token}` } });
  const started: string[] = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'request' || m.method !== 'job.start') return;
    started.push(m.params.cmd);
    const state = { id: m.params.id, kind: 'job', path: m.params.path, cmd: m.params.cmd, status: 'running', startedAt: new Date().toISOString(), runnerVersion: '0.1.0' };
    ws.send(JSON.stringify({ type: 'state', job: state })); ws.send(JSON.stringify({ type: 'response', id: m.id, result: state }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', user: 'root' }));
  for (let i = 0; i < 100 && !app.hub.online(serverId); i++) await sleep(20);
  const answers: string[] = [];
  const prompts: string[] = [];
  const client = new Client({ name: 'eliciting', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } });
  client.setRequestHandler('elicitation/create', async request => {
    prompts.push(String(request.params.message));
    const answer = answers.shift() ?? 'deny';
    return answer === 'cancel' ? { action: 'cancel' } : { action: 'accept', content: { decision: answer } };
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pat.token}` } } }));
  t.after(() => client.close());
  const call = async (cmd: string) => {
    const result = await client.callTool({ name: 'job_start', arguments: { serverId, path: '/', cmd, waitMs: 0 } }) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
  };
  answers.push('approve');
  assert.equal((await call('rm -rf /srv/a')).isError, false);
  assert.deepEqual(started, ['rm -rf /srv/a']);
  assert.match(prompts[0], /Hostherd approval request · target\nrm -rf \/srv\/a\nRules: rm -r/);
  answers.push('deny');
  const denied = await call('rm -rf /srv/b');
  assert.equal(denied.body.code, 'APPROVAL_DENIED');
  answers.push('always');
  assert.equal((await call('shred x')).isError, false);
  assert.equal(app.approvals.rules().find(rule => rule.id === 'shred')!.mode, 'allow');
  assert.equal((await call('shred y')).isError, false, 'the rule now allows without asking');
  assert.equal(prompts.length, 3);
  assert.deepEqual(started, ['rm -rf /srv/a', 'shred x', 'shred y']);
  // A client that dismisses the prompt without asking leaves the request pending behind the approval link.
  answers.push('cancel');
  const dismissed = await call('echo hi > /tmp/out.txt');
  assert.equal(dismissed.body.code, 'APPROVAL_REQUIRED');
  assert.match(dismissed.body.approvalUrl, /\/approvals\//);
  assert.equal(app.approvals.get(dismissed.body.approvalId).status, 'pending');
  app.approvals.decide(dismissed.body.approvalId, 'approve');
  assert.equal((await call('echo hi > /tmp/out.txt')).isError, false, 'the retry after web approval runs without asking again');
  assert.equal(prompts.length, 4);
  const history = app.approvals.list({ limit: 10, offset: 0 }).items.map(item => [item.command, item.status]);
  assert.deepEqual(history, [['echo hi > /tmp/out.txt', 'approved'], ['shred x', 'approved'], ['rm -rf /srv/b', 'denied'], ['rm -rf /srv/a', 'approved']]);
});
