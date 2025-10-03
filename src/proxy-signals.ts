import { type ChildProcess } from 'child_process'
import { allSignals } from './all-signals.js'

/**
 * Starts forwarding signals to `child` through `parent`.
 */
export const proxySignals = (child: ChildProcess) => {
  const listeners = new Map<NodeJS.Signals, () => void>()

  // Pre-allocate array to avoid iterator overhead
  const signals = allSignals
  const signalCount = signals.length

  for (let i = 0; i < signalCount; i++) {
    const sig = signals[i]
    if (!sig) continue
    // Optimize: Create listener inline to reduce closure allocations
    const listener = () => {
      // some signals can only be received, not sent
      try {
        child.kill(sig)
        /* c8 ignore start */
      } catch (_) {}
      /* c8 ignore stop */
    }
    try {
      // if it's a signal this system doesn't recognize, skip it
      process.on(sig, listener)
      listeners.set(sig, listener)
      /* c8 ignore start */
    } catch (_) {}
    /* c8 ignore stop */
  }

  const unproxy = () => {
    // Use for-of for better performance with Map iteration
    for (const [sig, listener] of listeners) {
      process.removeListener(sig, listener)
    }
  }
  child.on('exit', unproxy)
  return unproxy
}
