/**
 * DB Circuit Breaker
 * 
 * When a quota/connection error is detected, all polling workers pause
 * for a cooldown period instead of hammering the DB with failing queries.
 */

let tripped = false;
let tripTime: Date | null = null;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if an error is a fatal DB quota/connection error.
 */
export function isQuotaError(err: any): boolean {
  const msg = err?.message ?? err?.cause?.message ?? '';
  const code = err?.cause?.originalCode ?? err?.cause?.code ?? '';
  return (
    code === 'XX000' ||
    msg.includes('exceeded the compute time quota') ||
    msg.includes('too many connections') ||
    msg.includes('remaining connection slots are reserved')
  );
}

/**
 * Trip the circuit breaker — all workers should stop polling.
 */
export function tripBreaker(): void {
  if (!tripped) {
    console.warn(`[CircuitBreaker] ⚡ TRIPPED — pausing all DB polling for ${COOLDOWN_MS / 1000}s`);
  }
  tripped = true;
  tripTime = new Date();
}

/**
 * Check if polling is currently allowed.
 */
export function canPoll(): boolean {
  if (!tripped) return true;

  const elapsed = Date.now() - (tripTime?.getTime() ?? 0);
  if (elapsed >= COOLDOWN_MS) {
    tripped = false;
    tripTime = null;
    console.log('[CircuitBreaker] ✅ Cooldown expired — resuming DB polling');
    return true;
  }

  return false;
}
