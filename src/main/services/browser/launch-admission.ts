/** Main-process shutdown admission is sticky for this module's lifetime. */
let launchAdmissionClosed = false;

/** Close admission before taking any shutdown snapshot of owned browsers. */
export function closeBrowserLaunchAdmission(): void {
  launchAdmissionClosed = true;
}

/** Recheck after asynchronous preparation and before spawning/publishing ownership. */
export function assertBrowserLaunchAllowed(): void {
  if (launchAdmissionClosed) {
    throw Object.assign(new Error("Application is shutting down; new browser launches are disabled."), {
      code: "APP_SHUTTING_DOWN",
    });
  }
}
