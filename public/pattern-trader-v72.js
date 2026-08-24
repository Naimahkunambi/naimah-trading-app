// Compatibility entrypoint: observatory.html keeps loading pattern-trader-v72.js.
// The active implementation is now the Pattern Campaign v8 controller.
try {
  await import('./pattern-trader-v73.js');
} catch (error) {
  console.error('v8 controller failed to import', error);
  const box = document.getElementById('traderError');
  if (box) {
    box.textContent = `v8 load error: ${error?.message || error}`;
    box.classList.remove('hidden');
  }
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('SANI Pattern Campaign v8 · LOAD ERROR'));
}