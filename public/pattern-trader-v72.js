// Stable v7.3 bootstrap. Observatory keeps this entrypoint so old URLs remain valid.
import { V73UI } from './pattern-trader-v73-ui.js';
import { installCleanV73 } from './pattern-trader-v73-clean-ui.js';

// Build every DOM surface first. The controller may emit immediately when it subscribes.
V73UI.install();
installCleanV73();

loadController();

async function loadController() {
  try {
    const controller = await import('./pattern-trader-v73.js');
    // Dynamic imports can finish after DOMContentLoaded. v7.3 exports an explicit boot hook
    // after the companion controller patch; call it when available.
    controller.bootV73?.();
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
}
