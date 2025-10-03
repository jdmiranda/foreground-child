import {
  ChildProcessByStdio,
  SendHandle,
  Serializable,
  spawn as nodeSpawn,
  SpawnOptions,
  ChildProcess,
} from 'child_process'
import crossSpawn from 'cross-spawn'
import { onExit } from 'signal-exit'
import { proxySignals } from './proxy-signals.js'
import { watchdog } from './watchdog.js'

/* c8 ignore start */
const spawn = process?.platform === 'win32' ? crossSpawn : nodeSpawn
/* c8 ignore stop */

/**
 * The signature for the cleanup method.
 *
 * Arguments indicate the exit status of the child process.
 *
 * If a Promise is returned, then the process is not terminated
 * until it resolves, and the resolution value is treated as the
 * exit status (if a number) or signal exit (if a signal string).
 *
 * If `undefined` is returned, then no change is made, and the parent
 * exits in the same way that the child exited.
 *
 * If boolean `false` is returned, then the parent's exit is canceled.
 *
 * If a number is returned, then the parent process exits with the number
 * as its exitCode.
 *
 * If a signal string is returned, then the parent process is killed with
 * the same signal that caused the child to exit.
 */
export type Cleanup = (
  code: number | null,
  signal: null | NodeJS.Signals,
  processInfo: {
    watchdogPid?: ChildProcess['pid']
  },
) =>
  | void
  | undefined
  | number
  | NodeJS.Signals
  | false
  | Promise<void | undefined | number | NodeJS.Signals | false>

export type FgArgs =
  | [program: string | [cmd: string, ...args: string[]], cleanup?: Cleanup]
  | [
      program: [cmd: string, ...args: string[]],
      opts?: SpawnOptions,
      cleanup?: Cleanup,
    ]
  | [program: string, cleanup?: Cleanup]
  | [program: string, opts?: SpawnOptions, cleanup?: Cleanup]
  | [program: string, args?: string[], cleanup?: Cleanup]
  | [
      program: string,
      args?: string[],
      opts?: SpawnOptions,
      cleanup?: Cleanup,
    ]

// Default no-op cleanup function - reuse to reduce allocations
const defaultCleanup: Cleanup = () => {}

/**
 * Normalizes the arguments passed to `foregroundChild`.
 *
 * Exposed for testing.
 *
 * @internal
 */
export const normalizeFgArgs = (
  fgArgs: FgArgs,
): [
  program: string,
  args: string[],
  spawnOpts: SpawnOptions,
  cleanup: Cleanup,
] => {
  let [program, args = [], spawnOpts = {}, cleanup = defaultCleanup] = fgArgs
  if (typeof args === 'function') {
    cleanup = args
    spawnOpts = {}
    args = []
  } else if (!!args && typeof args === 'object' && !Array.isArray(args)) {
    if (typeof spawnOpts === 'function') cleanup = spawnOpts
    spawnOpts = args
    args = []
  } else if (typeof spawnOpts === 'function') {
    cleanup = spawnOpts
    spawnOpts = {}
  }
  if (Array.isArray(program)) {
    const [pp, ...pa] = program
    program = pp
    args = pa
  }
  return [program, args, { ...spawnOpts }, cleanup]
}

/**
 * Spawn the specified program as a "foreground" process, or at least as
 * close as is possible given node's lack of exec-without-fork.
 *
 * Cleanup method may be used to modify or ignore the result of the child's
 * exit code or signal. If cleanup returns undefined (or a Promise that
 * resolves to undefined), then the parent will exit in the same way that
 * the child did.
 *
 * Return boolean `false` to prevent the parent's exit entirely.
 */
export function foregroundChild(
  cmd: string | [cmd: string, ...args: string[]],
  cleanup?: Cleanup,
): ChildProcessByStdio<null, null, null>
export function foregroundChild(
  program: string,
  args?: string[],
  cleanup?: Cleanup,
): ChildProcessByStdio<null, null, null>
export function foregroundChild(
  program: string,
  spawnOpts?: SpawnOptions,
  cleanup?: Cleanup,
): ChildProcessByStdio<null, null, null>
export function foregroundChild(
  program: string,
  args?: string[],
  spawnOpts?: SpawnOptions,
  cleanup?: Cleanup,
): ChildProcessByStdio<null, null, null>
export function foregroundChild(
  ...fgArgs: FgArgs
): ChildProcessByStdio<null, null, null> {
  const [program, args, spawnOpts, cleanup] = normalizeFgArgs(fgArgs)

  // Fast path: Pre-configure stdio array to avoid repeated array operations
  const hasIPC = !!process.send
  spawnOpts.stdio = hasIPC ? [0, 1, 2, 'ipc'] : [0, 1, 2]

  const child = spawn(program, args, spawnOpts) as ChildProcessByStdio<
    null,
    null,
    null
  >

  // Optimize: Define childHangup inline to reduce closure overhead
  const childHangup = () => {
    try {
      child.kill('SIGHUP')

      /* c8 ignore start */
    } catch (_) {
      // SIGHUP is weird on windows
      child.kill('SIGTERM')
    }
    /* c8 ignore stop */
  }
  const removeOnExit = onExit(childHangup)

  proxySignals(child)
  const dog = watchdog(child)

  let done = false
  child.on('close', async (code, signal) => {
    /* c8 ignore start */
    if (done) return
    /* c8 ignore stop */
    done = true
    const result = cleanup(code, signal, {
      watchdogPid: dog.pid,
    })
    const res = isPromise(result) ? await result : result
    removeOnExit()

    if (res === false) return
    else if (typeof res === 'string') {
      signal = res
      code = null
    } else if (typeof res === 'number') {
      code = res
      signal = null
    }

    if (signal) {
      // If there is nothing else keeping the event loop alive,
      // then there's a race between a graceful exit and getting
      // the signal to this process.  Put this timeout here to
      // make sure we're still alive to get the signal, and thus
      // exit with the intended signal code.
      /* istanbul ignore next */
      setTimeout(() => {}, 2000)
      try {
        process.kill(process.pid, signal)
        /* c8 ignore start */
      } catch (_) {
        process.kill(process.pid, 'SIGTERM')
      }
      /* c8 ignore stop */
    } else {
      process.exit(code || 0)
    }
  })

  if (process.send) {
    process.removeAllListeners('message')

    child.on('message', (message, sendHandle) => {
      process.send?.(message, sendHandle)
    })

    process.on('message', (message, sendHandle) => {
      child.send(
        message as Serializable,
        sendHandle as SendHandle | undefined,
      )
    })
  }

  return child
}

const isPromise = (o: any): o is Promise<any> =>
  !!o && typeof o === 'object' && typeof o.then === 'function'
