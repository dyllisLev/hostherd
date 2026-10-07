import type { Terminal } from '@xterm/xterm';
import { installWebkitIme } from './xterm-webkit-ime';

const patched = Symbol('hostherd-xterm-ime-fix');

export interface CompositionHelper {
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _coreService: { triggerDataEvent(data: string, wasUserInput: boolean): void };
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _compositionPosition: { start: number; end: number };
  _dataAlreadySent: string;
  _finalizeComposition(waitForPropagation: boolean): void;
  compositionstart(): void;
  updateCompositionElements(): void;
  _handleAnyTextareaChanges(): void;
  [patched]: boolean | undefined;
}

/**
 * Backport xterm.js#6090 while @xterm/xterm 6.0.0 is the latest stable release.
 *
 * xterm defers composition sends with a shared boolean. When Korean composition
 * events arrive in a burst, a later key clears that boolean and silently drops
 * every queued syllable. Keep each deferred send in a FIFO and deduplicate by
 * textarea offset instead. Remove this shim after the upstream fix is released.
 */
export function applyXtermImeFix(terminal: Terminal): { flush(): void; dispose(): void } {
  const helper = (terminal as unknown as { _core?: { _compositionHelper?: CompositionHelper } })._core?._compositionHelper;
  if (!helper || typeof helper._finalizeComposition !== 'function' || typeof helper.compositionstart !== 'function') {
    throw new Error('The installed xterm.js version is incompatible with the Korean IME fix.');
  }
  if (helper[patched]) throw new Error('The Korean IME fix is already installed.');
  helper[patched] = true;

  const pendingSends: Array<() => void> = [];
  let sentUpTo = 0;
  const updatePendingState = () => { helper._isSendingComposition = pendingSends.length > 0; };
  const sliceUnsent = (start: number, end: number) => {
    const from = Math.max(start, sentUpTo);
    const to = Math.max(from, end);
    sentUpTo = Math.max(sentUpTo, to);
    return helper._textarea.value.substring(from, to);
  };

  const originalCompositionStart = helper.compositionstart.bind(helper);
  helper.compositionstart = () => {
    originalCompositionStart();
    // The hidden textarea may be rewritten between commands, so its absolute
    // offsets can move backwards.
    sentUpTo = Math.min(sentUpTo, helper._compositionPosition.start);
  };

  helper._finalizeComposition = (waitForPropagation: boolean) => {
    helper._compositionView.classList.remove('active');
    helper._isComposing = false;

    if (!waitForPropagation) {
      // A non-composition key must preserve all earlier completed syllables.
      for (const send of pendingSends.splice(0, pendingSends.length)) send();
      const end = Math.max(helper._compositionPosition.end, helper._textarea.selectionEnd ?? helper._compositionPosition.end);
      const input = sliceUnsent(helper._compositionPosition.start, end);
      if (input.length > 0) helper._coreService.triggerDataEvent(input, true);
      updatePendingState();
      return;
    }

    const position = { ...helper._compositionPosition };
    const send = () => {
      position.start += helper._dataAlreadySent.length;
      const end = helper._compositionPosition.start > position.start
        ? helper._compositionPosition.start
        : helper._textarea.value.length;
      const input = sliceUnsent(position.start, end);
      if (input.length > 0) helper._coreService.triggerDataEvent(input, true);
    };

    pendingSends.push(send);
    updatePendingState();
    setTimeout(() => {
      const index = pendingSends.indexOf(send);
      if (index !== -1) {
        pendingSends.splice(index, 1);
        send();
      }
      updatePendingState();
    }, 0);
  };
  const webkit = installWebkitIme(terminal, helper);
  return {
    flush() {
      webkit.flush();
      if (helper._isComposing || helper._isSendingComposition) helper._finalizeComposition(false);
    },
    dispose() { webkit.dispose(); },
  };
}
