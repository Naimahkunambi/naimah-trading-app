// Compatibility entrypoint: observatory.html keeps loading pattern-trader-v72.js.
// The active implementation is now the Sniper Campaign v8.1 controller.
try {
  await import('./pattern-trader-v73.js');
} catch (error) {
  console.error('v8.1 controller failed to import', error);
  const box = document.getElementById('traderError');
  if (box) {
    box.textContent = `v8.1 load error: ${error?.message || error}`;
    box.classList.remove('hidden');
  }
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('SANI Sniper Campaign v8.1 · LOAD ERROR'));
}
