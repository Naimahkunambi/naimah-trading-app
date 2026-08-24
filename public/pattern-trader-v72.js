// Compatibility/bootstrap entrypoint. Observatory still references this stable path.
// Install the v7.3 UI BEFORE loading the controller because SaniEngine.subscribe()
// emits an immediate snapshot during module evaluation.
import { V73UI } from './pattern-trader-v73-ui.js';

V73UI.install();

dynamicLoad();

async function dynamicLoad() {
  try {
    await import('./pattern-trader-v73.js');
  } catch (error) {
    console.error('v7.3 bootstrap failed', error);
    document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Pattern + Structure Sniper v7.3 · LOAD ERROR'));
    const box = document.getElementById('traderError');
    if (box) {
      box.textContent = `v7.3 failed to load: ${error?.message || error}`;
      box.classList.remove('hidden');
    }
  }
}
