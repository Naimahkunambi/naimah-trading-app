// SCHOOL → TEACH SANI → SANI WORK bridge.
// The old auto-promotion loop is intentionally retired.
// IMPORTANT: only libra-trader.js owns the 7-minute review cadence now.
// Calling window.LIBRA.review() on every new observation made LEARN/SANI_WORK
// flap repeatedly and paused the paid engine at random moments.
import './core/libra-execution-base.mjs';
import './core/libra-sniper.mjs';
import './core/libra-teacher.mjs';
import './core/libra-forward-timing.mjs';
import './core/libra-teacher-execution.mjs';
import './core/libra-clarity-overlay.mjs';
import './core/libra-audit-export.mjs';

export {};
