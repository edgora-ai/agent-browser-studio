import type { CdpClient } from "./cdp-transport.js";
import { NavigationBudget } from "./cdp-navigation-budget.js";
import {
  BrowserLoadTimeoutError, BrowserNavigationError, navigationConnectionClosed, navigationSuperseded,
} from "./cdp-navigation-errors.js";

type Send = (client: CdpClient, method: string, params?: any, sessionId?: string, timeoutMs?: number, signal?: AbortSignal) => Promise<any>;
type Identity = { frameId: string; loaderId: string };
type NavigationEvent =
  | { kind: "load" | "init" | "commit"; frameId: string; loaderId: string }
  | { kind: "start"; frameId: string; loaderId?: string; sameDocument?: boolean }
  | { kind: "same-document" | "detach"; frameId: string };
type Navigation = {
  origin: "navigate" | "standalone" | "external";
  phase: "preparing" | "pending" | "accepted";
  identity?: Identity;
  before?: Identity;
  pendingLoaderId?: string;
  previousComplete?: Identity;
  sameDocument: boolean;
  transitionConfirmed: boolean;
  completed: boolean;
  buffering: boolean;
  events: NavigationEvent[];
  evidenceLost: boolean;
  failure?: unknown;
};
type Tracker = {
  latest?: Navigation;
  rootFrameId?: string;
  lifecycleEnabled: boolean;
  closed?: Error;
  changed: Set<() => void>;
  detach: () => void;
};

// One bounded latest document/navigation per client; no URLs, raw events, or
// per-navigation listener history. Completed evidence survives split tool calls.
const trackers = new WeakMap<CdpClient, Tracker>();
const MAX_EARLY_EVENTS = 64;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
const sameIdentity = (a?: Identity, b?: Identity) => !!a && !!b && a.frameId === b.frameId && a.loaderId === b.loaderId;
const notify = (tracker: Tracker) => { for (const changed of [...tracker.changed]) changed(); };

function projectEvent(message: any): NavigationEvent | undefined {
  // This transport is attached directly to a page. A flattened child session
  // cannot provide root-page load proof, even if it reports the same frame id.
  if (!message || message.sessionId) return;
  const params = message.params;
  if (message.method === "Page.frameNavigated") {
    const frame = params?.frame;
    if (!frame?.parentId && identifier(frame?.id) && identifier(frame?.loaderId)) {
      return { kind: "commit", frameId: frame.id, loaderId: frame.loaderId };
    }
  }
  if (!identifier(params?.frameId)) return;
  if (message.method === "Page.lifecycleEvent" && identifier(params.loaderId) && (params.name === "load" || params.name === "init")) {
    return { kind: params.name, frameId: params.frameId, loaderId: params.loaderId };
  }
  if (message.method === "Page.frameStartedNavigating") {
    return { kind: "start", frameId: params.frameId,
      ...(identifier(params.loaderId) ? { loaderId: params.loaderId } : {}),
      sameDocument: params.navigationType === "sameDocument" || params.navigationType === "historySameDocument" };
  }
  const kind = message.method === "Page.navigatedWithinDocument" ? "same-document"
    : message.method === "Page.frameStartedLoading" ? "start"
      : message.method === "Page.frameDetached" ? "detach" : undefined;
  if (kind) return { kind, frameId: params.frameId };
}

function freshNavigation(origin: Navigation["origin"]): Navigation {
  return { origin, phase: "preparing", sameDocument: false, transitionConfirmed: false,
    completed: false, buffering: true, events: [], evidenceLost: false };
}

function applyStart(tracker: Tracker, navigation: Navigation, event: Extract<NavigationEvent, { kind: "start" }>, replay: boolean): void {
  // The acknowledged loader's own start may precede its buffered load. A
  // subsequent root start must invalidate that completion even while the frame
  // tree still exposes the previous committed document.
  if (replay && navigation.origin === "navigate" && !navigation.completed &&
      (!event.loaderId || event.loaderId === navigation.identity?.loaderId)) return;
  const identity = navigation.identity;
  const completed = navigation.completed;
  const sameDocument = navigation.phase === "accepted" && !!identity &&
    event.sameDocument === true && event.loaderId === identity.loaderId;
  const next = replay && navigation.origin === "standalone" ? navigation : freshNavigation("external");
  next.before = identity ?? navigation.before;
  next.identity = sameDocument ? identity : undefined;
  next.pendingLoaderId = event.loaderId;
  next.previousComplete = sameDocument && completed ? identity : undefined;
  next.phase = "pending";
  next.buffering = false;
  next.sameDocument = sameDocument;
  next.transitionConfirmed = false;
  next.completed = false;
  tracker.latest = next;
}

function applyEvent(tracker: Tracker, navigation: Navigation, event: NavigationEvent, replay = false): void {
  const root = navigation.identity?.frameId ?? navigation.before?.frameId ?? tracker.rootFrameId;
  if (event.frameId !== root || navigation.failure || navigation.evidenceLost) return;
  if (event.kind === "same-document") {
    if (navigation.sameDocument) {
      navigation.transitionConfirmed = true;
      navigation.phase = "accepted";
      navigation.pendingLoaderId = undefined;
      navigation.completed = sameIdentity(navigation.identity, navigation.previousComplete);
    }
    return;
  }
  if (event.kind === "load") {
    if (navigation.phase === "accepted" && event.loaderId === navigation.identity?.loaderId &&
        (!navigation.sameDocument || navigation.transitionConfirmed)) navigation.completed = true;
    return;
  }
  if (event.kind === "start") {
    applyStart(tracker, navigation, event, replay);
    return;
  }
  if (event.kind === "commit" || event.kind === "init") {
    if (event.loaderId === navigation.identity?.loaderId) return;
    if (navigation.origin !== "navigate" && navigation.phase === "pending") {
      if (navigation.pendingLoaderId ? event.loaderId !== navigation.pendingLoaderId : event.loaderId === navigation.before?.loaderId) return;
      navigation.identity = { frameId: event.frameId, loaderId: event.loaderId };
      navigation.pendingLoaderId = undefined;
      navigation.phase = "accepted";
      return;
    }
    // Buffered old commits/init events do not supersede an acknowledged loader.
    if (replay) return;
  }
  if (!replay) {
    const replacement = freshNavigation("external");
    replacement.buffering = false;
    replacement.phase = event.kind === "commit" || event.kind === "init" ? "accepted" : "pending";
    if (event.kind === "commit" || event.kind === "init") replacement.identity = { frameId: event.frameId, loaderId: event.loaderId };
    else replacement.before = navigation.identity ?? navigation.before;
    tracker.latest = replacement;
  }
}

function trackerFor(client: CdpClient): Tracker {
  const existing = trackers.get(client);
  if (existing) return existing;
  const tracker: Tracker = { lifecycleEnabled: false, changed: new Set(), detach: () => {} };
  const message = (bytes: Buffer) => {
    let parsed: any;
    try { parsed = JSON.parse(bytes.toString()); } catch { return; }
    const event = projectEvent(parsed);
    const navigation = tracker.latest;
    if (!event || !navigation || tracker.closed) return;
    if (navigation.buffering) {
      if (navigation.events.length < MAX_EARLY_EVENTS && !navigation.evidenceLost) navigation.events.push(event);
      else { navigation.evidenceLost = true; navigation.events.length = 0; }
    } else applyEvent(tracker, navigation, event);
    notify(tracker);
  };
  const closed = () => {
    tracker.closed = navigationConnectionClosed();
    if (tracker.latest) {
      tracker.latest.events.length = 0;
      tracker.latest.completed = false;
      tracker.latest.failure = tracker.closed;
    }
    tracker.detach();
    notify(tracker);
  };
  tracker.detach = () => {
    client.ws.off("message", message);
    client.ws.off("close", closed);
    client.ws.off("error", closed);
  };
  client.ws.on("message", message);
  client.ws.on("close", closed);
  client.ws.on("error", closed);
  trackers.set(client, tracker);
  if (client.ws.readyState !== undefined && client.ws.readyState !== 1) closed();
  return tracker;
}

export function closeCdpNavigation(client: CdpClient): void {
  const tracker = trackers.get(client);
  if (!tracker) return;
  tracker.closed = navigationConnectionClosed();
  if (tracker.latest) { tracker.latest.events.length = 0; tracker.latest.completed = false; }
  tracker.detach();
  notify(tracker);
}

function assertCurrent(tracker: Tracker, navigation: Navigation): void {
  if (tracker.closed) throw tracker.closed;
  if (tracker.latest !== navigation) throw navigationSuperseded();
}

function assertLoadEvidence(navigation: Navigation): void {
  if (navigation.failure) throw navigation.failure;
  if (navigation.evidenceLost) throw new BrowserNavigationError("BROWSER_NAVIGATION_EVIDENCE_LOST", "Browser navigation event buffer exceeded its evidence limit");
}

function command(budget: NavigationBudget, send: Send, client: CdpClient, method: string, params?: any): Promise<any> {
  return budget.run(() => send(client, method, params, undefined, budget.remaining(), budget.signal));
}

function rootIdentity(result: any): Identity {
  const frame = result?.frameTree?.frame;
  if (!frame?.parentId && identifier(frame?.id) && identifier(frame?.loaderId)) return { frameId: frame.id, loaderId: frame.loaderId };
  throw new BrowserNavigationError("BROWSER_NAVIGATION_IDENTITY_UNAVAILABLE", "CDP returned no root frame/document identity");
}

async function prepare(client: CdpClient, tracker: Tracker, budget: NavigationBudget, send: Send): Promise<Identity> {
  if (!tracker.lifecycleEnabled) {
    await command(budget, send, client, "Page.setLifecycleEventsEnabled", { enabled: true });
    budget.check();
    tracker.lifecycleEnabled = true;
  }
  const identity = rootIdentity(await command(budget, send, client, "Page.getFrameTree"));
  budget.check();
  tracker.rootFrameId = identity.frameId;
  return identity;
}

function replayEvents(tracker: Tracker, navigation: Navigation): void {
  navigation.buffering = false;
  const events = navigation.events.splice(0);
  for (const event of events) {
    if (tracker.latest) applyEvent(tracker, tracker.latest, event, true);
  }
  notify(tracker);
}

/** Acceptance only; full-load proof is retained for a later cdpWaitForLoad call. */
export async function navigateCdp(client: CdpClient, url: string, timeoutMs: number, send: Send): Promise<any> {
  const tracker = trackerFor(client);
  const navigation = freshNavigation("navigate");
  const previous = tracker.latest;
  if (previous?.completed && !previous.failure && !previous.evidenceLost) navigation.previousComplete = previous.identity;
  const budget = new NavigationBudget(timeoutMs, client.port,
    () => new BrowserNavigationError("BROWSER_NAVIGATION_TIMEOUT", "Browser navigation acceptance timed out"),
    () => { if (tracker.closed) throw tracker.closed; if (tracker.latest === navigation) assertCurrent(tracker, navigation); else if (tracker.latest !== previous) throw navigationSuperseded(); });
  tracker.latest = navigation;
  notify(tracker);
  try {
    navigation.before = await prepare(client, tracker, budget, send);
    budget.check();
    // Preparation can report the previous document's lifecycle. Only events
    // armed immediately before this navigation write can acknowledge its load.
    navigation.events.length = 0;
    navigation.evidenceLost = false;
    navigation.phase = "pending";
    const result = await command(budget, send, client, "Page.navigate", { url });
    budget.check();
    if (typeof result?.errorText === "string" && result.errorText.trim()) {
      throw new BrowserNavigationError("BROWSER_NAVIGATION_FAILED", `Browser navigation failed: ${result.errorText}`, result.errorText);
    }
    if (result?.frameId !== navigation.before.frameId) {
      throw new BrowserNavigationError("BROWSER_NAVIGATION_IDENTITY_UNAVAILABLE", "Navigation receipt does not identify the root frame");
    }
    navigation.phase = "accepted";
    if (result.isDownload === true) {
      navigation.failure = new BrowserNavigationError("BROWSER_NAVIGATION_DOWNLOAD", "Navigation became a download, not a loaded page");
    } else if (identifier(result.loaderId)) {
      navigation.identity = { frameId: result.frameId, loaderId: result.loaderId };
    } else {
      navigation.sameDocument = true;
      navigation.identity = navigation.before;
    }
    replayEvents(tracker, navigation);
    budget.check();
    return result;
  } catch (error) {
    budget.fail(error);
    if (tracker.latest === navigation) {
      if (navigation.phase === "preparing" && !tracker.closed) {
        // No Page.navigate was dispatched. A's cancelled preparation is not a
        // shared document failure; B may verify the unchanged current document.
        // Keep all bounded evidence, including provisional external starts.
        // Reclassify in place: no document was replaced, so an independent B
        // already waiting on this reservation must not be spuriously superseded.
        const { events, evidenceLost } = navigation;
        Object.assign(navigation, freshNavigation("standalone"), {
          events, evidenceLost, identity: undefined, before: undefined,
          pendingLoaderId: undefined, previousComplete: undefined, failure: undefined,
        });
      } else {
        navigation.failure = error;
        navigation.events.length = 0;
        navigation.buffering = false;
      }
      notify(tracker);
    }
    throw error;
  } finally { budget.close(); }
}

async function probeCurrentReadiness(client: CdpClient, navigation: Navigation, budget: NavigationBudget, send: Send): Promise<void> {
  const before = navigation.identity;
  if (!before) return;
  const world = await command(budget, send, client, "Page.createIsolatedWorld", { frameId: before.frameId, worldName: "agent-navigation-readiness" });
  budget.check();
  if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId < 1) {
    throw new BrowserNavigationError("BROWSER_NAVIGATION_IDENTITY_UNAVAILABLE", "CDP returned no frame-bound execution context");
  }
  const result = await command(budget, send, client, "Runtime.evaluate", {
    expression: "document.readyState", contextId: world.executionContextId, returnByValue: true,
  });
  budget.check();
  if (result?.exceptionDetails) throw new BrowserNavigationError("BROWSER_LOAD_EVALUATION_FAILED", "Frame-bound readiness evaluation failed");
  const after = rootIdentity(await command(budget, send, client, "Page.getFrameTree"));
  budget.check();
  if (!sameIdentity(before, after)) throw navigationSuperseded();
  if (result?.result?.value === "complete") navigation.completed = true;
}

function waitForChange(tracker: Tracker, budget: NavigationBudget): Promise<void> {
  let changed!: () => void;
  const pending = budget.run(() => new Promise<void>((resolve) => {
    changed = resolve;
    tracker.changed.add(changed);
  }));
  return pending.finally(() => tracker.changed.delete(changed));
}

export async function waitForCdpLoad(client: CdpClient, timeoutMs: number, send: Send): Promise<void> {
  const tracker = trackerFor(client);
  const standalone = !tracker.latest;
  const navigation = tracker.latest ?? freshNavigation("standalone");
  const budget = new NavigationBudget(timeoutMs, client.port, () => new BrowserLoadTimeoutError(),
    () => { if (tracker.closed) throw tracker.closed; if (tracker.latest && tracker.latest !== navigation) throw navigationSuperseded(); });
  if (standalone) tracker.latest = navigation;
  const prepareStandalone = async () => {
    if (navigation.origin === "standalone" && !navigation.evidenceLost) {
      // Preparation belongs to the caller, not to the shared client. Another
      // current-document waiter may retry it if this caller is cancelled.
      if (navigation.phase === "preparing") {
        const identity = await prepare(client, tracker, budget, send);
        budget.check();
        if (navigation.identity && !sameIdentity(navigation.identity, identity)) throw navigationSuperseded();
        if (navigation.buffering) {
          navigation.identity = identity;
          navigation.phase = "accepted";
          replayEvents(tracker, navigation);
        }
      } else if (navigation.phase === "accepted") {
        const current = rootIdentity(await command(budget, send, client, "Page.getFrameTree"));
        if (!sameIdentity(navigation.identity, current)) throw navigationSuperseded();
      }
      // Only a standalone current-document wait may use readiness. A pending
      // Page.navigate/start can still expose the previous complete document.
      if (navigation.phase === "accepted" && !navigation.completed && !navigation.evidenceLost) {
        await probeCurrentReadiness(client, navigation, budget, send);
        if (navigation.completed) notify(tracker);
      }
      budget.check();
    }
  };
  try {
    await prepareStandalone();
    for (;;) {
      budget.check();
      assertCurrent(tracker, navigation);
      if (navigation.origin === "standalone" && navigation.phase === "preparing") {
        await prepareStandalone();
        budget.check();
      }
      assertLoadEvidence(navigation);
      if (navigation.phase === "accepted" && navigation.sameDocument && navigation.transitionConfirmed && !navigation.completed) {
        // A fresh connection may have missed this document's original load.
        // The acknowledged same-document transition permits a bound readiness
        // check; a missing loader alone never does.
        const before = rootIdentity(await command(budget, send, client, "Page.getFrameTree"));
        if (!sameIdentity(navigation.identity, before)) throw navigationSuperseded();
        await probeCurrentReadiness(client, navigation, budget, send);
        budget.check();
        if (navigation.completed) notify(tracker);
      }
      if (navigation.phase === "accepted" && navigation.completed) {
        // Confirm the retained completion still describes the current document.
        const current = rootIdentity(await command(budget, send, client, "Page.getFrameTree"));
        budget.check();
        if (!sameIdentity(navigation.identity, current)) throw navigationSuperseded();
        return;
      }
      await waitForChange(tracker, budget);
      budget.check();
    }
  } finally { budget.close(); }
}
