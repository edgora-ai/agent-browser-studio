import { AsyncLocalStorage } from "node:async_hooks";
import type { BidiConnection } from "../bidi-client.js";
import { runningProcesses } from "../browser/runtime-table.js";

export interface BidiMutationSettlement {
  readonly settled: boolean;
  readonly done: Promise<void>;
  confirm(): void;
  interrupt(reason: unknown): void;
}
interface MutationScope {
  begin(port: number, connection: BidiConnection | undefined): BidiMutationSettlement;
}
const mutationScope = new AsyncLocalStorage<MutationScope>();

/** Only sync's live Firefox import opts in. A local command rejection is not a
 * terminal reply, and losing the socket does not stop a browser-side writer. */
export async function withSyncBidiMutationSettlement<T>(dirId: string, run: () => Promise<T>): Promise<T> {
  const entry = runningProcesses.get(dirId);
  if (entry?.engine !== "firefox") return run();
  const child = entry.process, pid = entry.pid, port = entry.port, connection = entry.bidiConn;
  const outstanding = new Set<BidiMutationSettlement>();
  let accepting = true, listening = false, exited = false, interrupted: Error | undefined;
  let resolveDrain!: () => void;
  const drained = new Promise<void>(resolve => { resolveDrain = resolve; });
  const interrupt = (reason: unknown) => {
    interrupted ??= reason instanceof Error ? reason : new Error("BiDi Cookie mutation completion is unconfirmed");
  };
  const terminalChild = () => Number.isInteger(child?.exitCode) ||
    (typeof child?.signalCode === "string" && child.signalCode.length > 0);
  const onExit = (code: number | null, signal: string | null) => {
    // Ignore a stop request or an unrelated emitter/runtime replacement. These
    // are the captured child's terminal fields, set by ChildProcess on exit.
    if (!((Number.isInteger(code) && child.exitCode === code) ||
        (typeof signal === "string" && signal.length > 0 && child.signalCode === signal))) return;
    exited = true;
    if (outstanding.size) interrupt(new Error("Firefox exited with an unconfirmed Cookie mutation"));
    for (const ticket of outstanding) ticket.confirm();
  };
  const scope: MutationScope = {
    begin(actualPort, actualConnection) {
      if (!accepting || exited) throw new Error("BiDi Cookie mutation scope is no longer active");
      if (interrupted) throw interrupted;
      const current = runningProcesses.get(dirId);
      if (!child || typeof child.on !== "function" || typeof child.removeListener !== "function" ||
          !connection || connection.closed || actualConnection !== connection || actualPort !== port ||
          !current || current.process !== child || current.pid !== pid || child.pid !== pid || current.port !== port ||
          current.engine !== "firefox" || current.bidiConn !== connection || current.stopping || child.killed === true ||
          child.exitCode !== null || child.signalCode !== null) {
        throw new Error("FIREFOX_COOKIE_TARGET_CHANGED");
      }
      if (!listening) {
        // Subscribe before dispatch, then close the subscribe/exit race without
        // using process.kill, a replacement entry, or the socket's close event.
        listening = true;
        child.on("exit", onExit);
      }
      if (exited || terminalChild()) throw new Error("FIREFOX_COOKIE_TARGET_CHANGED");
      let settled = false, resolve!: () => void;
      const done = new Promise<void>(finish => { resolve = finish; });
      const ticket: BidiMutationSettlement = {
        get settled() { return settled; },
        done,
        confirm() {
          if (settled) return;
          settled = true;
          outstanding.delete(ticket);
          resolve();
          if (!accepting && !outstanding.size) resolveDrain();
        },
        // Protocol completion does not erase a subsequent local delivery failure.
        interrupt(reason) { interrupt(reason); },
      };
      outstanding.add(ticket);
      return ticket;
    },
  };
  try {
    return await mutationScope.run(scope, run);
  } finally {
    accepting = false;
    if (!outstanding.size) resolveDrain();
    await drained;
    if (listening) child.removeListener("exit", onExit);
    // A late success only drains the old request; it cannot revive a cancelled
    // import or permit subsequent Cookie dispatch after an unconfirmed failure.
    if (interrupted) throw interrupted;
  }
}

/** Called at the real dispatch point, not when a Cookie import is merely queued. */
export function beginSyncBidiMutation(port: number, connection: BidiConnection | undefined): BidiMutationSettlement | undefined {
  return mutationScope.getStore()?.begin(port, connection);
}
