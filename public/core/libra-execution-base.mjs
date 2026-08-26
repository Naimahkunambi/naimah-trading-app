import { SaniEngine } from './engine.mjs';

if (!globalThis.__LIBRA_ORIGINAL_SANI_EXECUTE__) {
  globalThis.__LIBRA_ORIGINAL_SANI_EXECUTE__ = SaniEngine.prototype.execute;
}
