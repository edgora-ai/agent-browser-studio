/** Only this timeout is translated to the public browser_wait_for_load loaded:false result. */
export class BrowserLoadTimeoutError extends Error {
  readonly code = "BROWSER_LOAD_TIMEOUT";
  constructor() {
    super("Browser page did not finish loading before the deadline");
    this.name = "BrowserLoadTimeoutError";
  }
}

export class BrowserNavigationError extends Error {
  constructor(readonly code: string, message: string, readonly errorText?: string) {
    super(message);
    this.name = "BrowserNavigationError";
  }
}

export function navigationSuperseded(): BrowserNavigationError {
  return new BrowserNavigationError("BROWSER_NAVIGATION_SUPERSEDED", "Browser navigation was superseded by another document or navigation");
}

export function navigationConnectionClosed(): BrowserNavigationError {
  return new BrowserNavigationError("BROWSER_CONNECTION_CLOSED", "Browser navigation connection closed");
}
