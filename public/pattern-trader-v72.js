// Stable v7.3 bootstrap. Observatory keeps this entrypoint so old URLs remain valid.
import { V73UI } from './pattern-trader-v73-ui.js';
import { installCleanV73 } from './pattern-trader-v73-clean-ui.js';

// Build the visible cockpit first.
V73UI.install();
installCleanV73();

const errorBox = () => document.getElementById('traderError');
const showBootError = message => {
  console.error(message);
  const title = document.querySelector('#v73CleanShell h1') || document.querySelector('.topbar h1');
  title?.replaceChildren(document.createTextNode('Pattern + Structure Sniper v7.3 · LOAD ERROR'));
  const box = errorBox();
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
  }
};

// The controller was written to boot from DOMContentLoaded. Depending on module/cache timing,
// that event can already be past by the time a dynamic dependency registers its callback.
// Capture ONLY the DOMContentLoaded listeners registered while importing the controller,
// then run those callbacks exactly once ourselves. This avoids re-firing DOMContentLoaded
// for observatory.js and guarantees Load Accounts / Connect / Start get their handlers.
const nativeAddEventListener = window.addEventListener;
const controllerReadyCallbacks = [];
window.addEventListener = function(type, listener, options) {
  if (type === 'DOMContentLoaded') {
    controllerReadyCallbacks.push(listener);
    return;
  }
  return nativeAddEventListener.call(this, type, listener, options);
};

try {
  await import('./pattern-trader-v73.js');
} catch (error) {
  showBootError(`v7.3 controller failed to import: ${error?.message || error}`);
} finally {
  window.addEventListener = nativeAddEventListener;
}

if (!document.querySelector('#v73CleanShell h1')?.textContent?.includes('LOAD ERROR')) {
  const evt = new Event('DOMContentLoaded');
  for (const listener of controllerReadyCallbacks) {
    try {
      if (typeof listener === 'function') listener.call(window, evt);
      else listener?.handleEvent?.(evt);
    } catch (error) {
      showBootError(`v7.3 controller boot failed: ${error?.message || error}`);
      break;
    }
  }

  // Make a dead control impossible to fail silently again.
  const loadButton = document.getElementById('ptLoadAccounts');
  if (typeof loadButton?.onclick !== 'function') {
    showBootError('v7.3 controller did not bind the account controls.');
  } else {
    document.querySelector('#v73CleanShell .cleanStatus .pill:last-child')?.replaceChildren(document.createTextNode('CONTROLS READY'));
  }
}
