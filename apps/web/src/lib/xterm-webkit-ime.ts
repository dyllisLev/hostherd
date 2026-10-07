import type { Terminal } from '@xterm/xterm';
import type { CompositionHelper } from './xterm-ime';

const hangul = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]+$/u;
const modifier = /^(Shift|Control|Alt|Meta|CapsLock)$/;

/** Safari can edit Hangul in the textarea without firing composition events.
 * Keep the editable tail local, including delete/insert pairs and batchim moves.
 * See xterm.js#5704 and the physical iPad trace in stablyai/orca#15480.
 */
export function installWebkitIme(terminal: Terminal, helper: CompositionHelper) {
  const element = terminal.element;
  const textarea = terminal.textarea;
  const navigator = textarea?.ownerDocument.defaultView?.navigator;
  const webkit = navigator && /AppleWebKit/.test(navigator.userAgent)
    && !/(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
  const empty = { flush() {}, dispose() {} };
  if (!webkit || !element || !textarea) return empty;

  let synthetic = false;
  let native = false;
  let start = 0;
  let held = '';
  let previous = '';
  let boundaryInput: string | null = null;
  let editGeneration = 0;
  const listeners: Array<() => void> = [];
  const listen = (type: string, listener: EventListener) => {
    // The terminal root sees events before xterm's textarea capture listeners.
    element.addEventListener(type, listener, true);
    listeners.push(() => element.removeEventListener(type, listener, true));
  };
  const hide = () => {
    helper._compositionView.textContent = '';
    helper._compositionView.classList.remove('active');
  };
  const preview = () => {
    helper._compositionView.textContent = held;
    helper._compositionView.classList.toggle('active', held.length > 0);
    helper.updateCompositionElements();
  };
  const flush = () => {
    if (!synthetic) return;
    const text = held;
    synthetic = false;
    held = previous = '';
    editGeneration++;
    helper._isComposing = false;
    hide();
    if (text) helper._coreService.triggerDataEvent(text, true);
  };
  const begin = () => {
    if (synthetic) return;
    if (helper._isSendingComposition) helper._finalizeComposition(false);
    synthetic = true;
    start = textarea.selectionStart ?? textarea.value.length;
    held = previous = '';
    editGeneration++;
    helper._isComposing = true;
    helper._dataAlreadySent = '';
    helper._compositionPosition = { start, end: start };
  };

  // A 229 keydown may already have scheduled xterm's textarea diff before we
  // see beforeinput. Invalidate that send even if Enter flushes in the same tick.
  const originalChanges = helper._handleAnyTextareaChanges;
  helper._handleAnyTextareaChanges = () => {
    const oldValue = textarea.value;
    const generation = editGeneration;
    setTimeout(() => {
      if (generation !== editGeneration || helper._isComposing) return;
      const newValue = textarea.value;
      const diff = newValue.replace(oldValue, '');
      helper._dataAlreadySent = diff;
      if (newValue.length > oldValue.length) helper._coreService.triggerDataEvent(diff, true);
      else if (newValue.length < oldValue.length) helper._coreService.triggerDataEvent('\x7f', true);
      else if (newValue !== oldValue) helper._coreService.triggerDataEvent(newValue, true);
    }, 0);
  };

  listen('keydown', event => {
    if (event.target !== textarea || native || (helper._isComposing && !synthetic)) return;
    const key = event as KeyboardEvent;
    const plain = !key.ctrlKey && !key.metaKey && !key.altKey;
    if (plain && hangul.test(key.key)) {
      begin();
      // Do not preventDefault: iPadOS must be allowed to compose in the field.
      event.stopPropagation();
    } else if (synthetic) {
      if (modifier.test(key.key) || key.keyCode === 229 || key.isComposing
        || (plain && key.key === 'Backspace' && held.length > 0)) {
        event.stopPropagation();
      } else flush();
    }
  });
  listen('keypress', event => {
    if (event.target !== textarea || native) return;
    const key = event as KeyboardEvent;
    if (synthetic || (!key.ctrlKey && !key.metaKey && !key.altKey && hangul.test(key.key))) event.stopPropagation();
  });
  listen('beforeinput', event => {
    if (event.target !== textarea || native || (helper._isComposing && !synthetic) || helper._isSendingComposition) return;
    const input = event as InputEvent;
    if (input.inputType === 'insertText' || input.inputType === 'insertReplacementText') {
      if (input.data && hangul.test(input.data.normalize('NFC'))) begin();
      else if (synthetic && input.inputType === 'insertText' && input.data) {
        flush();
        boundaryInput = input.data;
      }
    } else if (synthetic && /^(insertLineBreak|insertParagraph)$/.test(input.inputType)) {
      flush();
      boundaryInput = '\r';
    }
  });
  listen('input', event => {
    if (event.target !== textarea) return;
    const input = event as InputEvent;
    if (boundaryInput !== null) {
      event.stopPropagation();
      helper._coreService.triggerDataEvent(boundaryInput, true);
      boundaryInput = null;
      return;
    }
    if (!synthetic) {
      // Native composition owns its final insertText too; xterm's generic input
      // handler must not send a second copy while its composition send is queued.
      if (native || helper._isComposing || helper._isSendingComposition) event.stopPropagation();
      return;
    }
    event.stopPropagation();
    held = textarea.value.slice(start).normalize('NFC');
    if (!input.inputType.startsWith('delete')) {
      const before = Array.from(previous);
      const after = Array.from(held);
      let stable = 0;
      // Keep at least the previous final character: a newly appended consonant
      // can still move to/from that syllable on the next vowel.
      while (stable < Math.min(before.length - 1, after.length - 1) && before[stable] === after[stable]) stable++;
      if (stable > 0) {
        const committed = after.slice(0, stable).join('');
        helper._coreService.triggerDataEvent(committed, true);
        // Browser field offsets are UTF-16, before NFC normalization.
        let rawEnd = start;
        while (rawEnd < textarea.value.length && textarea.value.slice(start, rawEnd).normalize('NFC') !== committed) rawEnd++;
        start = rawEnd;
        held = after.slice(stable).join('');
        helper._compositionPosition.start = start;
      }
      previous = held;
    }
    preview();
  });
  listen('compositionstart', event => {
    if (event.target !== textarea) return;
    flush();
    native = true;
  });
  listen('compositionend', event => {
    if (event.target === textarea) native = false;
  });
  listen('paste', event => { if (event.target === textarea) flush(); });
  listen('blur', event => { if (event.target === textarea) flush(); });

  return {
    flush,
    dispose() {
      for (const remove of listeners) remove();
      helper._handleAnyTextareaChanges = originalChanges;
      if (synthetic) { synthetic = false; helper._isComposing = false; hide(); }
      editGeneration++;
    },
  };
}
