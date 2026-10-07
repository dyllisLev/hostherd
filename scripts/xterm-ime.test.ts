import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import { applyXtermImeFix } from '../apps/web/src/lib/xterm-ime.ts';

function fixture() {
  const received: string[] = [];
  const textarea = { value: '', selectionEnd: 0 };
  const helper = {
    _textarea: textarea,
    _compositionView: { classList: { add() {}, remove() {} }, textContent: '' },
    _coreService: { triggerDataEvent: (data: string) => received.push(data) },
    _isComposing: false,
    _isSendingComposition: false,
    _compositionPosition: { start: 0, end: 0 },
    _dataAlreadySent: '',
    _finalizeComposition() {},
    compositionstart() {
      this._isComposing = true;
      this._compositionPosition.start = this._textarea.value.length;
      this._dataAlreadySent = '';
      this._compositionView.classList.add();
    },
  };
  applyXtermImeFix({ _core: { _compositionHelper: helper } } as unknown as Terminal);
  return { helper, received, textarea };
}

test('queued Korean compositions are sent in order before a following key', async () => {
  const { helper, received, textarea } = fixture();

  helper.compositionstart();
  textarea.value = '니';
  textarea.selectionEnd = 1;
  helper._compositionPosition.end = 1;
  helper._finalizeComposition(true);

  helper.compositionstart();
  textarea.value = '니다';
  textarea.selectionEnd = 2;
  helper._compositionPosition.end = 2;
  helper._finalizeComposition(true);

  helper._finalizeComposition(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(received.join(''), '니다');
});

test('a key interrupting composition sends text before its position timer runs', () => {
  const { helper, received, textarea } = fixture();
  helper.compositionstart();
  textarea.value = '가';
  textarea.selectionEnd = 1;

  helper._finalizeComposition(false);
  assert.equal(received.join(''), '가');
});
