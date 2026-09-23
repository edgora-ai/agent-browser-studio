/**
 * The one size budget for config.json, shared by the read path (config-manager
 * load: stat cap before JSON.parse) and the write path (config/store transact:
 * byte count before the tmp file is created). They MUST agree — a write that
 * produces a file the reader refuses to load would brick the next start, and a
 * reader stricter than the writer would reject its own output.
 *
 * Measured on the final serialized JSON in UTF-8 BYTES, not characters: a
 * config of Chinese display names is 3 bytes per character and would otherwise
 * slip past a .length check at 3x the intended size.
 */
export const CONFIG_MAX_BYTES = 64 * 1024 * 1024;

/** Raised when config data exceeds CONFIG_MAX_BYTES on either path — a write
 *  that would produce an unreadable file, or a load of a file that is already
 *  over budget. Distinct from corruption: callers must never report it as a
 *  damaged file (no .corrupt backup, and no "delete the config" advice — the
 *  data on disk is intact). The message is phrased for both directions, so it
 *  does not claim a write happened when the read path raised it. */
export class ConfigTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(bytes: number, what = "config.json") {
    super(
      `${what} is too large (${bytes} bytes, max ${CONFIG_MAX_BYTES / (1024 * 1024)} MiB). ` +
      `Nothing was discarded — the existing data is intact.`,
    );
    this.name = "ConfigTooLargeError";
    this.bytes = bytes;
    this.maxBytes = CONFIG_MAX_BYTES;
  }
}

/** Reject a size that exceeds the shared budget. The writer passes the UTF-8
 *  byte length of its serialized text; the reader passes the file's stat size.
 *  No environment variable, flag or injectable override changes the budget —
 *  both call sites read the same module constant. */
export function assertConfigSize(bytes: number, what?: string): void {
  if (bytes > CONFIG_MAX_BYTES) throw new ConfigTooLargeError(bytes, what);
}
