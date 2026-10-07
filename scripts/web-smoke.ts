import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit, devices, expect, type Browser, type Page } from '@playwright/test';
import { createApp } from '../apps/server/src/app.js';

const check = expect.configure({ timeout: 15_000 });
const binary = path.resolve(process.env.AGENT_BINARY ?? '/tmp/hostherd-agent-dev');
const fixture = await mkdtemp(path.join(tmpdir(), 'hostherd-web-smoke-'));
const dataDir = path.join(fixture, 'central');
const stateDir = path.join(fixture, 'runtime');
const files = path.join(fixture, 'files');
const artifacts = path.resolve('artifacts');
await mkdir(files);
await mkdir(artifacts, { recursive: true });
const port = await new Promise<number>(resolve => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1', () => {
    const assigned = (reservation.address() as { port: number }).port;
    reservation.close(() => resolve(assigned));
  });
});
const base = 'http://127.0.0.1:' + port;
const app = await createApp({ dataDir, publicUrl: base, metricsIntervalMs: 5000 });
const report: Record<string, unknown> = {};
const errors: string[] = [];
const warnings: string[] = [];
const resizeMessages: { cols: number; rows: number }[] = [];
let browser: Browser | undefined;
let safari: Browser | undefined;
let agent: ChildProcess | undefined;
let runner: ChildProcess | undefined;
let serverId = '';
let passed = false;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
function child(mode: string, args: string[]) {
  const process = spawn(binary, [mode, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout?.on('data', data => void appendFile(path.join(fixture, mode + '.log'), data));
  process.stderr?.on('data', data => void appendFile(path.join(fixture, mode + '.log'), data));
  return process;
}
async function stop(process?: ChildProcess) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await until(() => process.exitCode !== null || process.signalCode !== null, 'fixture child exits', 10_000);
}
async function output(id: string) {
  try { return await readFile(app.store.outputPath(id), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
function pinKorean() { localStorage.setItem('hostherd.language', 'ko'); }
async function noHorizontalOverflow(page: Page) {
  await check.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { timeout: 3000 }).toBe(true);
}
async function shell(page: Page, command: string) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');
}
async function showTerminalKeys(page: Page) {
  const toggle = page.getByRole('button', { name: '보조 키', exact: true });
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(page.getByRole('button', { name: 'Ctrl+C', exact: true })).toBeVisible();
}
async function fastKoreanIme(page: Page) {
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.insertText('알겠습');
  // Reproduce two completed Hangul compositions arriving before xterm's deferred
  // send timer, followed immediately by Enter. Stock xterm 6.0.0 drops `니`.
  await page.evaluate(`(() => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!textarea) throw new Error('xterm textarea missing');
    const nativeSetTimeout = window.setTimeout;
    const queued = [];
    window.setTimeout = (handler) => {
      if (typeof handler !== 'function') throw new Error('unexpected string timer');
      queued.push(handler);
      return queued.length;
    };
    const dispatch = (type, data = '') => textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    const compose = (text) => {
      dispatch('compositionstart');
      textarea.value += text;
      dispatch('compositionupdate', text);
      const updatePosition = queued.pop();
      if (!updatePosition) throw new Error('composition update timer missing');
      updatePosition();
      dispatch('compositionend', text);
    };
    compose('니');
    compose('다');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'keyCode', { get: () => 13 });
    textarea.dispatchEvent(enter);
    const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
    Object.defineProperty(enterUp, 'keyCode', { get: () => 13 });
    textarea.dispatchEvent(enterUp);
    window.setTimeout = nativeSetTimeout;
    for (const callback of queued) callback();
  })()`);
}

try {
  await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BINARY ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] });
  // Assertions below use the Korean UI; pin it regardless of the browser language.
  await context.addInitScript(pinKorean);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'resize') resizeMessages.push({ cols: message.cols, rows: message.rows });
      } catch { /* Browser protocol frames are not application messages. */ }
    });
  });

  await page.goto(base);
  await check(page.getByRole('heading', { name: '관리자 계정 만들기' })).toBeVisible();
  await page.getByLabel('초기 설정 코드').fill((await readFile(path.join(dataDir, 'setup-token'), 'utf8')).trim());
  await page.getByLabel('사용자 이름', { exact: true }).fill('web-smoke');
  await page.getByLabel('비밀번호', { exact: true }).fill('local-web-smoke-password');
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  await check(page.getByRole('heading', { name: '대시보드', exact: true })).toBeVisible();
  report.setup = 'Initial account created through browser; no setup code logged';

  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '서버', exact: true }).click();
  await page.getByRole('button', { name: '서버 등록', exact: true }).first().click();
  await page.getByLabel('서버 이름').fill('자동 감지 서버');
  assert.equal(await page.getByLabel('실행 계정').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'web-enrollment-desktop.png'), fullPage: true });
  const generalResponse = page.waitForResponse(response => response.url() === base + '/api/enrollments' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '설치 명령 발급', exact: true }).click();
  assert.equal((await generalResponse).status(), 201);
  await check(page.getByText('에이전트 연결을 기다리는 중…', { exact: true })).toBeVisible();
  await check(page.getByText(/일반 사용자가 sudo로 실행하면 그 사용자/)).toBeVisible();
  await page.keyboard.press('Escape');
  report.enrollment = 'Only a server name is requested; the installer reports its detected execution account';

  await page.getByRole('button', { name: '서버 등록', exact: true }).first().click();
  await page.getByLabel('서버 이름').fill('개발 서버');
  const rootResponse = page.waitForResponse(response => response.url() === base + '/api/enrollments' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '설치 명령 발급', exact: true }).click();
  const enrollment = await (await rootResponse).json();
  const enrolledResponse = await page.request.post(base + '/api/agent/enroll', { data: { code: enrollment.code, hostname: 'web-fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' } });
  assert.equal(enrolledResponse.status(), 201);
  const enrolled = await enrolledResponse.json();
  serverId = enrolled.serverId;
  const config = path.join(fixture, 'config.json');
  await writeFile(config, JSON.stringify({ url: base, token: enrolled.token, serverId, executionUser: 'root', stateDir, generation: '0.1.0', version: '0.1.0' }), { mode: 0o600 });
  runner = child('runner', ['--state-dir', stateDir, '--generation', '0.1.0']);
  agent = child('agent', ['--config', config]);
  await until(() => app.hub.online(serverId), 'web fixture agent online');
  await check(page.getByText('개발 서버 서버가 연결되었습니다', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
  await check(page.getByRole('row').filter({ hasText: '개발 서버' }).getByText('온라인', { exact: true })).toBeVisible();

  // The real agent reports resource samples every 5 s in this fixture.
  await until(() => Boolean(app.metrics.latest(serverId)), 'agent metrics sample', 30_000);
  await page.getByRole('row').filter({ hasText: '개발 서버' }).getByRole('link', { name: '개발 서버' }).click();
  await page.getByRole('tab', { name: '리소스' }).click();
  await check(page.getByText('CPU 사용률', { exact: true })).toBeVisible();
  await check(page.getByText('파일시스템', { exact: true })).toBeVisible();
  await check(page.locator('[role=meter]').first()).toBeVisible();
  const sample = app.metrics.latest(serverId)!.sample;
  assert.ok(sample.memTotal && sample.memTotal > 0 && sample.disks.length > 0 && sample.cpus > 0, 'real host sample has memory, disks and CPU count');
  await page.screenshot({ path: path.join(artifacts, 'web-resources-desktop.png'), fullPage: true });
  report.metrics = 'Real agent announced metrics, reported host CPU/memory/disk samples, and the resources tab rendered them';

  await page.getByRole('link', { name: '설정', exact: true }).click();
  const languageSaved = page.waitForResponse(response => response.url() === base + '/api/settings/language' && response.request().method() === 'PUT');
  await page.getByRole('radiogroup', { name: '언어', exact: true }).getByRole('radio', { name: 'English', exact: true }).click();
  await check(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.ok((await languageSaved).ok(), 'language choice is saved on the server');
  assert.equal((await page.request.get(base + '/api/settings').then(response => response.json())).language, 'en');
  await page.getByRole('radiogroup', { name: 'Language', exact: true }).getByRole('radio', { name: '한국어', exact: true }).click();
  await check(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
  report.language = 'Settings switches between English and Korean in place, updates <html lang> and saves the choice on the server';
  await page.getByRole('tab', { name: 'MCP 연결' }).click();
  await check(page.getByText(base + '/mcp', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '개인 토큰' }).click();
  await page.getByRole('button', { name: '토큰 발급', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill('개발 노트북');
  await page.getByRole('dialog').getByRole('button', { name: '토큰 발급', exact: true }).click();
  await check(page.getByRole('heading', { name: '토큰이 발급되었습니다' })).toBeVisible();
  const issued = await page.getByRole('dialog').locator('code').textContent();
  assert.ok(issued?.startsWith('hostherd_'), 'PAT is shown once');
  await page.getByRole('button', { name: '토큰 복사', exact: true }).click();
  await check(page.getByRole('button', { name: '복사됨', exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => navigator.clipboard.readText()) === issued, 'Clipboard must contain the issued token');
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await check(page.getByRole('row').filter({ hasText: '개발 노트북' })).toBeVisible();
  assert.equal(await page.locator('body').textContent().then(text => text?.includes(issued!)), false, 'PAT must not remain on page after dialog closes');
  await page.screenshot({ path: path.join(artifacts, 'web-settings-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '개발 노트북 토큰 폐기', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '토큰 폐기', exact: true }).click();
  await check(page.getByRole('row').filter({ hasText: '개발 노트북' })).toHaveCount(0);
  report.personalToken = 'Issue, one-time display, clipboard copy and revoke passed';

  const complete = await app.hub.start(serverId, 'job', { path: files, cmd: 'printf "안녕하세요 · Hostherd\\n"' });
  await until(() => app.store.job(complete.id).status === 'completed', 'sample job completed');
  const interactive = await app.hub.start(serverId, 'job', { path: files, cmd: 'IFS= read -r line; printf "입력:%s\\n" "$line"; cat; printf "EOF 완료\\n"' });
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '작업', exact: true }).click();
  await check(page.getByRole('link', { name: complete.cmd, exact: true })).toBeVisible();
  await page.getByRole('link', { name: complete.cmd, exact: true }).click();
  await check(page.getByLabel('작업 출력')).toContainText('안녕하세요 · Hostherd');
  await page.screenshot({ path: path.join(artifacts, 'web-job-desktop.png'), fullPage: true });
  await page.goto(base + '/#jobs/' + interactive.id);
  await page.getByLabel('표준입력', { exact: true }).fill('웹 입력');
  await page.getByRole('button', { name: '입력 전송', exact: true }).click();
  await check(page.getByLabel('작업 출력')).toContainText('입력:웹 입력');
  await page.getByRole('button', { name: 'EOF 보내기', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'EOF 보내기', exact: true }).click();
  await until(() => app.store.job(interactive.id).status === 'completed', 'browser EOF closes stdin');
  await check(page.getByLabel('작업 출력')).toContainText('EOF 완료');
  report.jobs = 'Browse command, UTF-8 output, stdin and EOF passed';

  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '터미널', exact: true }).click();
  await page.getByRole('button', { name: '새 터미널', exact: true }).first().click();
  await page.getByLabel('서버', { exact: true }).selectOption(serverId);
  await page.getByLabel('시작 경로').fill(files);
  const terminalResponse = page.waitForResponse(response => response.url() === base + '/api/terminals' && response.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: '터미널 열기', exact: true }).click();
  const terminal = await (await terminalResponse).json();
  await check(page.locator('.xterm-helper-textarea')).toBeAttached();
  await check(page.getByText('연결됨', { exact: true })).toBeVisible();
  await shell(page, 'stty -echo; printf "\\nIME_%s\\n" READY; IFS= read -r line; stty echo; printf "\\nHANGUL_%s=%s\\n" RESULT "$line"');
  await until(async () => (await output(terminal.id)).includes('IME_READY\r\n'), 'terminal waits for IME input');
  await fastKoreanIme(page);
  await until(async () => (await output(terminal.id)).includes('HANGUL_RESULT='), 'terminal receives IME input');
  assert.ok((await output(terminal.id)).includes('HANGUL_RESULT=알겠습니다\r\n'), 'fast Korean IME composition must preserve every syllable');
  report.terminalIme = 'Fast Korean IME composition preserved every syllable through WebSocket and PTY';
  safari = await webkit.launch({ headless: true });
  const safariContext = await safari.newContext({ ...devices['iPad Pro 11'], storageState: await context.storageState(), locale: 'ko-KR' });
  await safariContext.addInitScript(pinKorean);
  const safariPage = await safariContext.newPage();
  safariPage.on('pageerror', error => errors.push('WebKit: ' + error.message));
  await safariPage.goto(base + '/#terminals/' + terminal.id);
  await check(safariPage.getByText('연결됨', { exact: true })).toBeVisible();
  await shell(safariPage, 'stty -echo; printf "\\nSAFARI_%s\\n" READY; IFS= read -r line; stty echo; printf "\\nSAFARI_%s=%s\\n" RESULT "$line"');
  await until(async () => (await output(terminal.id)).includes('SAFARI_READY\r\n'), 'PTY waits for WebKit Hangul');
  await check(safariPage.locator('.xterm-rows')).toContainText('SAFARI_READY');
  await safariPage.evaluate(`(() => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    const base = textarea.value;
    const key = new KeyboardEvent('keydown', { key: 'ㅎ', code: 'KeyG', keyCode: 71, bubbles: true, cancelable: true });
    textarea.dispatchEvent(key);
    if (key.defaultPrevented) throw new Error('iPad Hangul key must remain available to the OS');
    let previous = '';
    for (const value of ['ㅎ', '', '하', '', '한', '한ㄱ', '한', '한그', '한', '한글', '한글ㄲ', '한글', '한글깨', '한글', '한글깾', '한글', '한글깨지', '한글깨', '한글깨짐']) {
      const deleting = value.length < previous.length;
      const inputType = deleting ? 'deleteContentBackward' : 'insertText';
      const data = deleting ? null : value.slice(-1);
      textarea.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, composed: true }));
      textarea.value = base + value;
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true, composed: true }));
      previous = value;
    }
  })()`);
  await safariPage.screenshot({ path: path.join(artifacts, 'web-terminal-safari-ime.png'), fullPage: true });
  await showTerminalKeys(safariPage);
  await safariPage.getByRole('button', { name: 'Enter', exact: true }).click();
  await until(async () => (await output(terminal.id)).includes('SAFARI_RESULT='), 'PTY receives WebKit Hangul');
  assert.ok((await output(terminal.id)).includes('SAFARI_RESULT=한글깨짐\r\n'), 'WebKit iPad edit trace must preserve composed Hangul through the real PTY');
  await safariPage.reload();
  await check(safariPage.getByText('연결됨', { exact: true })).toBeVisible();
  await shell(safariPage, 'printf "SAFARI_%s\\n" RECONNECTED');
  await until(async () => (await output(terminal.id)).includes('SAFARI_RECONNECTED\r\n'), 'WebKit input after reconnect');
  report.safariIme = 'Playwright WebKit with iPad settings: recorded delete/insert and batchim migration event sequence, toolbar Enter, real WebSocket/Go PTY and reconnect passed; physical iPad not tested';
  await safari.close(); safari = undefined;
  await shell(page, 'export HOSTHERD_UI=kept; printf "UI_%s\\n" "READY"');
  await until(async () => (await output(terminal.id)).includes('UI_READY\r\n'), 'terminal browser input');
  const pid = app.store.job(terminal.id).pid;
  await page.reload();
  await check(page.getByText('연결됨', { exact: true })).toBeVisible();
  await shell(page, 'printf "RESTORED:%s:%s\\n" "$HOSTHERD_UI" "$PWD"');
  await until(async () => (await output(terminal.id)).includes('RESTORED:kept:' + files + '\r\n'), 'same terminal environment after page reload');
  assert.equal(app.store.job(terminal.id).pid, pid);
  const before = resizeMessages.at(-1);
  await page.setViewportSize({ width: 1120, height: 860 });
  await until(() => resizeMessages.length > 0 && (resizeMessages.at(-1)?.cols !== before?.cols || resizeMessages.at(-1)?.rows !== before?.rows), 'browser resize sent');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await delay(200);
  const dimensions = resizeMessages.at(-1)!;
  await shell(page, 'stty size');
  await until(async () => (await output(terminal.id)).includes(dimensions.rows + ' ' + dimensions.cols + '\r\n'), 'PTY matches browser dimensions');
  await shell(page, 'sleep 30');
  await delay(200);
  await page.keyboard.press('Control+c');
  await shell(page, 'printf "CTRL_%s\\n" "OK"');
  await until(async () => (await output(terminal.id)).includes('CTRL_OK\r\n'), 'browser Ctrl+C interrupts foreground process', 10_000);
  await showTerminalKeys(page);
  await shell(page, 'sleep 30');
  await delay(200);
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await check(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.insertText('c');
  await check(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await shell(page, 'printf "STICKY_%s\\n" "OK"');
  await until(async () => (await output(terminal.id)).includes('STICKY_OK\r\n'), 'sticky Ctrl key bar interrupts foreground process', 10_000);
  const embedded = resizeMessages.at(-1)!;
  await page.getByRole('button', { name: '전체 화면', exact: true }).click();
  await until(() => resizeMessages.at(-1)!.rows > embedded.rows, 'full-screen terminal grows', 10_000);
  await page.screenshot({ path: path.join(artifacts, 'web-terminal-fullscreen.png') });
  await page.getByRole('button', { name: '전체 화면 해제', exact: true }).click();
  await until(() => resizeMessages.at(-1)!.rows === embedded.rows, 'terminal restores embedded size', 10_000);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'web-terminal-desktop.png'), fullPage: true });
  report.terminal = 'Native PTY browser input, page reload with same PID/cwd/env, resize, keyboard and sticky key-bar Ctrl+C, full-screen resize passed';

  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '대시보드', exact: true }).click();
  await check(page.getByRole('heading', { name: '대시보드', exact: true })).toBeVisible();
  const fleet = page.locator('section', { has: page.getByRole('heading', { name: '서버 현황', exact: true }) });
  await check(fleet.getByRole('link').filter({ hasText: '개발 서버' })).toBeVisible();
  await check(fleet.locator('[role=meter]').first()).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'web-dashboard-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'web-dashboard-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await check(page.getByRole('dialog', { name: '주 메뉴', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('link', { name: '서버', exact: true }).click();
  await check(page.getByRole('dialog')).toHaveCount(0);
  await check(page.getByRole('heading', { name: '서버', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'web-servers-mobile.png'), fullPage: true });
  report.responsive = '1440px desktop and 390×844 mobile; no document overflow; mobile menu navigation passed';

  await page.goto(base + '/#terminals/' + terminal.id);
  await check(page.getByText('연결됨', { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await shell(page, 'ls --color=always /; pwd');
  await until(async () => /\u001b\[[0-9;]*m/.test(await output(terminal.id)), 'terminal stores ANSI color output');
  await page.screenshot({ path: path.join(artifacts, 'web-terminal-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '세션 종료', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '세션 종료', exact: true }).click();
  await until(() => app.store.job(terminal.id).status !== 'running', 'terminal explicitly closed');
  await check(page.getByText('세션 종료됨', { exact: true })).toBeVisible();
  report.terminalClose = 'Explicit browser close ends native PTY';

  await page.goto(base + '/#jobs/' + terminal.id);
  await check(page.getByLabel('작업 출력')).toContainText('bin');
  await check(page.getByLabel('작업 출력')).toContainText(files);
  assert.doesNotMatch(await page.getByLabel('작업 출력').innerText(), /[\u001b\u0007\r]/, 'Ended terminal history must not expose ANSI/title/control characters');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'web-terminal-history-mobile.png'), fullPage: true });
  report.terminalHistory = 'Ended terminal ls/pwd history is readable without ANSI control characters; stored bytes retain colors';

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '계정 메뉴', exact: true }).click();
  await page.getByRole('menuitem', { name: '로그아웃', exact: true }).click();
  await check(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  await page.getByLabel('사용자 이름', { exact: true }).fill('web-smoke');
  await page.getByLabel('비밀번호', { exact: true }).fill('local-web-smoke-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await check(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  report.login = 'Logout and subsequent login passed';

  assert.deepEqual(errors, [], 'Browser pageerror/console.error must be empty');
  report.pageErrors = errors;
  report.consoleWarnings = warnings;
  report.screenshots = ['web-enrollment-desktop.png', 'web-resources-desktop.png', 'web-settings-desktop.png', 'web-job-desktop.png', 'web-terminal-desktop.png', 'web-terminal-fullscreen.png', 'web-terminal-safari-ime.png', 'web-dashboard-desktop.png', 'web-dashboard-mobile.png', 'web-servers-mobile.png', 'web-terminal-mobile.png', 'web-terminal-history-mobile.png'];
  await writeFile(path.join(artifacts, 'web-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} catch (error) {
  console.error('Web smoke failed; fixture diagnostics: ' + fixture);
  const pages = browser?.contexts().flatMap(context => context.pages()) ?? [];
  if (pages[0]) {
    console.error('Layout diagnostics:', await pages[0].evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('*')].map(element => ({ element, rect: element.getBoundingClientRect() })).filter(({ rect }) => rect.right > innerWidth + 1 && rect.width > 0).slice(0, 15).map(({ element, rect }) => ({ tag: element.tagName, className: element.className, right: rect.right, width: rect.width, position: getComputedStyle(element).position })),
    })));
    await pages[0].screenshot({ path: path.join(artifacts, 'web-failure.png'), fullPage: true, mask: [pages[0].locator('input[type=password]'), pages[0].getByRole('dialog').locator('code, pre, dd')] }).catch(() => undefined);
  }
  throw error;
} finally {
  await safari?.close();
  await browser?.close();
  if (serverId && app.hub.online(serverId)) {
    for (const job of app.store.jobs().filter(job => job.status === 'running')) {
      await app.hub.rpc(serverId, job.kind === 'terminal' ? 'terminal.close' : 'job.cancel', { id: job.id }).catch(() => undefined);
    }
  }
  await stop(agent); await stop(runner); await app.close();
  if (passed) await rm(fixture, { recursive: true, force: true });
}
