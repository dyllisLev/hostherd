import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type Page } from '@playwright/test';
import type { Terminal } from '@xterm/xterm';

// Synthetic DOM event replay against the actual xterm package in Chromium and
// WebKit. This does not claim to drive an iPad's native keyboard/IME.
// Device-event reference: https://github.com/stablyai/orca/pull/13346
// Replacement-event reference: https://github.com/xtermjs/xterm.js/pull/5704
const ipadUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const bundle = await build({
  entryPoints: [resolve('apps/web/src/lib/xterm-ime.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'ImeFix',
  platform: 'browser',
});
const xtermScript = resolve('node_modules/@xterm/xterm/lib/xterm.js');
const xtermCss = await readFile(resolve('node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

type Scenario =
  | 'replacement' | 'hardware' | 'backspace' | 'space-enter'
  | 'toolbar' | 'native' | 'native-insert-text' | 'native-burst' | 'blur' | '229-enter'
  | 'soft-space' | 'soft-enter';
type Result = { sent: string[]; keys: Array<{ key: string; type: string; defaultPrevented: boolean }>; field: string };

async function preparePage(page: Page): Promise<void> {
  await page.setContent('<!doctype html><html><head></head><body><div id="terminal" style="width:900px;height:320px"></div></body></html>');
  await page.addStyleTag({ content: xtermCss });
  // tsx preserves nested function names using this helper; Playwright serializes
  // the evaluate callback without the helper from its Node module scope.
  await page.addScriptTag({ content: 'globalThis.__name = (fn, name) => Object.defineProperty(fn, "name", { value: name, configurable: true });' });
  await page.addScriptTag({ path: xtermScript });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

async function replay(page: Page, scenario: Scenario, patched: boolean): Promise<Result> {
  return page.evaluate(async ({ scenario, patched }) => {
    type ImeHandle = { flush(): void; dispose(): void };
    const browserWindow = window as unknown as {
      Terminal: new (options: object) => Terminal;
      ImeFix: { applyXtermImeFix(terminal: Terminal): ImeHandle };
    };
    const host = document.getElementById('terminal')!;
    host.replaceChildren();
    const term = new browserWindow.Terminal({ cols: 80, rows: 12, fontSize: 14, cursorBlink: false });
    term.open(host);
    const sent: string[] = [];
    const keys: Result['keys'] = [];
    const subscription = term.onData(data => sent.push(data));
    const ime = patched ? browserWindow.ImeFix.applyXtermImeFix(term) : undefined;
    const textarea = term.textarea!;
    term.focus();
    const drain = () => new Promise<void>(resolve => setTimeout(resolve, 20));
    const key = (type: string, text: string, keyCode: number, code = '', shiftKey = false, ctrlKey = false) => {
      const charCode = type === 'keypress' ? text.codePointAt(0) ?? 0 : 0;
      const event = new KeyboardEvent(type, {
        key: text, code, keyCode: type === 'keypress' ? charCode : keyCode,
        which: type === 'keypress' ? charCode : keyCode, charCode,
        bubbles: true, cancelable: true, composed: true, shiftKey, ctrlKey,
      });
      textarea.dispatchEvent(event);
      keys.push({ key: text, type, defaultPrevented: event.defaultPrevented });
      return event.defaultPrevented;
    };
    const edit = (value: string, inputType: string, data: string | null, isComposing = false) => {
      const before = new InputEvent('beforeinput', { inputType, data, isComposing, bubbles: true, cancelable: true, composed: true });
      textarea.dispatchEvent(before);
      if (before.defaultPrevented) throw new Error(`${inputType} was default-prevented; the native IME cannot edit its field`);
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new InputEvent('input', { inputType, data, isComposing, bubbles: true, composed: true }));
    };
    const composition = (type: string, data = '') => {
      textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, composed: true }));
    };
    const enter = () => {
      key('keydown', 'Enter', 13, 'Enter');
      key('keyup', 'Enter', 13, 'Enter');
    };
    const hardware = (text: string, code: string, keyCode: number, values: string[], shiftKey = false) => {
      const canceledDown = key('keydown', text, keyCode, code, shiftKey);
      const canceledPress = canceledDown ? true : key('keypress', text, keyCode, code, shiftKey);
      // A canceled key does not invoke the native text editor. Replaying writes
      // anyway would conceal the original iPad failure this test must catch.
      if (!canceledDown && !canceledPress) {
        for (const value of values) {
          if (value.length < textarea.value.length) {
            edit(value, 'deleteContentBackward', null);
          } else {
            let prefix = 0;
            while (prefix < value.length && prefix < textarea.value.length && value[prefix] === textarea.value[prefix]) prefix++;
            edit(value, 'insertText', value.slice(prefix));
          }
        }
      }
      key('keyup', text, keyCode, code, shiftKey);
    };
    const typeHan = () => {
      hardware('ㅎ', 'KeyG', 71, ['ㅎ']);
      hardware('ㅏ', 'KeyK', 75, ['', '하']);
      hardware('ㄴ', 'KeyS', 83, ['', '한']);
    };
    const nativeHan = (finalInputType = 'insertCompositionText') => {
      const base = textarea.value;
      composition('compositionstart');
      for (const value of ['ㅎ', '하', '한']) {
        composition('compositionupdate', value);
        edit(base + value, 'insertCompositionText', value, true);
      }
      composition('compositionend', '한');
      // Native WebKit can deliver a final input after compositionend as well.
      edit(base + '한', finalInputType, '한');
    };

    try {
      switch (scenario) {
        case 'replacement':
          edit('ㅎ', 'insertText', 'ㅎ');
          edit('하', 'insertReplacementText', '하');
          edit('한', 'insertReplacementText', '한');
          edit('한ㄱ', 'insertText', 'ㄱ');
          edit('한그', 'insertReplacementText', '그');
          edit('한글', 'insertReplacementText', '글');
          enter();
          break;
        case 'hardware':
          typeHan();
          hardware('ㄱ', 'KeyR', 82, ['한ㄱ']);
          hardware('ㅡ', 'KeyM', 77, ['한', '한그']);
          hardware('ㄹ', 'KeyF', 70, ['한', '한글']);
          hardware('ㄲ', 'KeyR', 82, ['한글ㄲ'], true);
          hardware('ㅐ', 'KeyO', 79, ['한글', '한글깨']);
          hardware('ㅈ', 'KeyW', 87, ['한글', '한글깾']);
          hardware('ㅣ', 'KeyL', 76, ['한글', '한글깨지']);
          hardware('ㅁ', 'KeyA', 65, ['한글깨', '한글깨짐']);
          enter();
          break;
        case 'backspace':
          typeHan();
          if (!key('keydown', 'Backspace', 8, 'Backspace')) {
            edit('', 'deleteContentBackward', null);
            edit('하', 'insertText', '하');
          }
          key('keyup', 'Backspace', 8, 'Backspace');
          hardware('ㄹ', 'KeyF', 70, ['', '할']);
          enter();
          break;
        case 'space-enter':
          typeHan();
          if (!key('keydown', ' ', 32, 'Space')) {
            if (!key('keypress', ' ', 32, 'Space')) edit(textarea.value + ' ', 'insertText', ' ');
          }
          key('keyup', ' ', 32, 'Space');
          enter();
          break;
        case 'toolbar':
          typeHan();
          if (!ime) throw new Error('The toolbar scenario requires the flush API');
          ime.flush();
          term.input('\u0003', true);
          ime.flush();
          break;
        case 'native':
          nativeHan();
          await drain();
          enter();
          break;
        case 'native-insert-text':
          nativeHan('insertText');
          await drain();
          enter();
          break;
        case 'native-burst':
          composition('compositionstart');
          composition('compositionupdate', '니');
          edit('니', 'insertCompositionText', '니', true);
          composition('compositionend', '니');
          composition('compositionstart');
          composition('compositionupdate', '다');
          edit('니다', 'insertCompositionText', '다', true);
          composition('compositionend', '다');
          enter();
          break;
        case 'blur':
          typeHan();
          textarea.blur();
          await drain();
          term.focus();
          hardware('ㄱ', 'KeyR', 82, ['ㄱ']);
          hardware('ㅡ', 'KeyM', 77, ['', '그']);
          hardware('ㄹ', 'KeyF', 70, ['', '글']);
          enter();
          break;
        case '229-enter':
          key('keydown', 'Process', 229);
          edit('ㅎ', 'insertText', 'ㅎ');
          edit('하', 'insertReplacementText', '하');
          edit('한', 'insertReplacementText', '한');
          enter();
          break;
        case 'soft-space':
          typeHan();
          key('keydown', 'Process', 229);
          edit('한 ', 'insertText', ' ');
          key('keyup', 'Process', 229);
          enter();
          break;
        case 'soft-enter':
          typeHan();
          key('keydown', 'Process', 229);
          edit('한\n', 'insertLineBreak', null);
          key('keyup', 'Process', 229);
          break;
      }
      await drain();
      return { sent, keys, field: textarea.value };
    } finally {
      ime?.dispose();
      subscription.dispose();
      term.dispose();
    }
  }, { scenario, patched });
}

const expected: Record<Scenario, string> = {
  replacement: '한글\r', hardware: '한글깨짐\r', backspace: '할\r',
  'space-enter': '한 \r', toolbar: '한\u0003', native: '한\r', 'native-insert-text': '한\r',
  'native-burst': '니다\r', blur: '한글\r', '229-enter': '한\r',
  'soft-space': '한 \r', 'soft-enter': '한\r',
};
let failures = 0;
let checks = 0;
async function check(label: string, action: () => Promise<void>): Promise<void> {
  checks++;
  try {
    await action();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.stack : error}`);
  }
}

async function run(browser: Browser, label: string, ipad: boolean): Promise<void> {
  const context = await browser.newContext(ipad ? { userAgent: ipadUserAgent, hasTouch: true } : {});
  if (ipad) {
    await context.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
  }
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await preparePage(page);
    if (ipad || label === 'webkit') {
      for (const scenario of ['hardware', 'replacement'] as const) {
        await check(`${label} original reproduces ${scenario} failure`, async () => {
          const result = await replay(page, scenario, false);
          assert.notEqual(result.sent.join(''), expected[scenario], 'The unpatched control unexpectedly passed; check that the failing event path was actually exercised');
        });
      }
      for (const scenario of Object.keys(expected) as Scenario[]) {
        await check(`${label} patched ${scenario}`, async () => {
          const result = await replay(page, scenario, true);
          assert.equal(result.sent.join(''), expected[scenario]);
          if (scenario === 'hardware') {
            const jamoKeys = result.keys.filter(event => /^[\u3131-\u318e]$/u.test(event.key));
            assert.ok(jamoKeys.some(event => event.key === 'ㄲ' && event.type === 'keypress'), 'Shift+jamo keypress must be exercised');
            assert.ok(jamoKeys.every(event => !event.defaultPrevented), 'Jamo keys must remain available to the OS text editor');
            assert.ok(result.sent.every(data => !/[\u3131-\u318e\u0008\u007f]/u.test(data)), 'Composition must not send intermediate jamo or PTY erasures');
          }
        });
      }
    } else {
      for (const scenario of ['native', 'native-burst'] as const) {
        await check(`${label} patched ${scenario}`, async () => {
          const result = await replay(page, scenario, true);
          assert.equal(result.sent.join(''), expected[scenario]);
        });
      }
    }
    await check(`${label} no uncaught browser errors`, async () => assert.deepEqual(pageErrors, []));
  } finally {
    await context.close();
  }
}

const chrome = await chromium.launch({
  executablePath: process.env.CHROME_BINARY ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  await run(chrome, 'chromium iPad events', true);
  await run(chrome, 'chromium desktop', false);
} finally {
  await chrome.close();
}
const safari = await webkit.launch({ headless: true });
try {
  await run(safari, 'webkit', false);
} finally {
  await safari.close();
}
console.log(`Synthetic IME browser regressions: ${checks - failures}/${checks} passed. Native iPad keyboard input was not exercised.`);
if (failures) process.exitCode = 1;
