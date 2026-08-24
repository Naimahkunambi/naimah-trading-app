// Stable v7.3 bootstrap. Observatory keeps this entrypoint so old URLs remain valid.
import { V73UI } from './pattern-trader-v73-ui.js';
import { installCleanV73 } from './pattern-trader-v73-clean-ui.js';

// Build every visible surface first.
V73UI.install();
installCleanV73();

// IMPORTANT: await the controller at module scope. Module scripts participate in
// DOMContentLoaded, so this guarantees the controller registers its account/connect/start
// handlers before DOMContentLoaded fires. The previous fire-and-forget import raced the event.
try {
  await import('./pattern-trader-v73.js');
} catch (error) {
  console.error('v7.3 bootstrap failed', error);
  const title = document.querySelector('#v73CleanShell h1') || document.querySelector('.topbar h1');
  title?.replaceChildren(document.createTextNode('Pattern + Structure Sniper v7.3 · LOAD ERROR'));
  const box = document.getElementById('traderError');
  if (box) {
    box.textContent = `v7.3 failed to load: ${error?.message || error}`;
    box.classList.remove('hidden');
  }
}
