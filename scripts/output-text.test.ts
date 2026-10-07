import assert from 'node:assert/strict';
import test from 'node:test';
import { outputText } from '../apps/web/src/lib/output-text.js';

test('ended Bash history displays ls/pwd without colors, titles, paste modes or duplicate prompt redraws', () => {
  const prompt = '\x1b[?2004h\x1b]0;root@instance-1: /\x07root@instance-1:/# ';
  const raw = prompt + '\r\x1b[K\r' + prompt + 'ls\r\n'
    + '\x1b[?2004l\r\x1b[0m\x1b[01;36mbin\x1b[0m  \x1b[01;34metc\x1b[0m\r\n'
    + prompt + 'pwd\r\n\x1b[?2004l\r/\r\n' + prompt;
  assert.equal(outputText(raw), 'root@instance-1:/# ls\nbin  etc\nroot@instance-1:/# pwd\n/\nroot@instance-1:/# ');
});

test('plain UTF-8 output and spaces are preserved; carriage-return redraws show the latest line', () => {
  assert.equal(outputText('안녕하세요  · Hostherd\n'), '안녕하세요  · Hostherd\n');
  assert.equal(outputText('10%\r50%\r100%\r\n완료\n'), '100%\n완료\n');
  const chunks = ['\x1b[01;', '34m한글\x1b[0m\r', '\n'];
  assert.equal(outputText(chunks.join('')), '한글\n');
});
