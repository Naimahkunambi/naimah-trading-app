import { buildWorkerEngine } from './worker-lib.mjs';

const { engine, context } = await buildWorkerEngine();
console.log(`SANI worker connected to ${context.account.account_type.toUpperCase()} account ${context.accountId}.`);
engine.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { engine.stop(); engine.disconnect(); } finally { process.exit(0); }
  });
}
