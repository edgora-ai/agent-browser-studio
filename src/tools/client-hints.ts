/** Strict RFC 8941 subset used by Chromium UA client hints; no I/O. */
export interface ClientHintBrand { brand: string; version: string }
export interface ChromiumVersion {
  version: string;
  major: string;
  tuple: readonly [number, number, number, number];
}
export interface ChromiumProductVersion extends ChromiumVersion {
  product: "Chrome" | "Chromium" | "HeadlessChrome" | "HeadlessChromium";
}
export class ClientHintsParseError extends Error {
  constructor(message: string) { super(message); this.name = "ClientHintsParseError"; }
}
const invalid = (message: string): never => { throw new ClientHintsParseError(message); };

class StructuredFieldReader {
  private offset = 0;
  constructor(private readonly text: string) {
    if (typeof text !== "string" || text.length > 16384) invalid("Invalid or oversized Structured Field");
  }
  whitespace(): void { while (this.text[this.offset] === " " || this.text[this.offset] === "\t") this.offset++; }
  consume(character: string): boolean {
    if (this.text[this.offset] !== character) return false;
    this.offset++;
    return true;
  }
  string(): string {
    if (!this.consume('"')) invalid("Structured Field item must be a quoted string");
    let result = "";
    while (this.offset < this.text.length) {
      const character = this.text[this.offset++];
      if (character === '"') return result;
      if (character === "\\") {
        const escaped = this.text[this.offset++];
        if (escaped !== '"' && escaped !== "\\") invalid("Invalid Structured Field string escape");
        result += escaped;
      } else {
        const code = character.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) invalid("Structured Field strings must contain printable ASCII");
        result += character;
      }
    }
    return invalid("Unterminated Structured Field string");
  }
  brand(): ClientHintBrand {
    const brand = this.string();
    if (!brand) invalid("Client hint brand must not be empty");
    if (!this.consume(";")) invalid("Client hint brand requires a version parameter");
    // RFC 8941 permits SP (not HTAB) between ';' and the parameter key.
    while (this.consume(" ")) { /* consume permitted parameter spacing */ }
    if (!this.consume("v") || !this.consume("=")) invalid("Client hint brand requires exactly one v parameter");
    const version = this.string();
    if (!version) invalid("Client hint brand version must not be empty");
    return { brand, version };
  }
  end(): void { this.whitespace(); if (this.offset !== this.text.length) invalid("Unexpected Structured Field suffix"); }
  list<T>(item: () => T): T[] {
    this.whitespace();
    if (this.offset === this.text.length) invalid("Client hint list must not be empty");
    const result: T[] = [];
    for (;;) {
      if (result.length === 32) invalid("Too many client hint list members");
      result.push(item());
      this.whitespace();
      if (!this.consume(",")) break;
      this.whitespace();
    }
    this.end();
    return result;
  }
}

export function parseClientHintString(value: string): string {
  const reader = new StructuredFieldReader(value);
  reader.whitespace();
  const result = reader.string();
  reader.end();
  return result;
}
export function parseClientHintBoolean(value: string): boolean {
  const match = typeof value === "string" && /^[ \t]*\?[01][ \t]*$/.exec(value);
  if (!match || match[0] !== value) invalid("Client hint boolean must be ?0 or ?1");
  return value.trim() === "?1";
}
export function parseClientHintBrands(value: string): ClientHintBrand[] {
  const reader = new StructuredFieldReader(value);
  return reader.list(() => reader.brand());
}
export function parseClientHintFormFactors(value: string): string[] {
  const reader = new StructuredFieldReader(value);
  return reader.list(() => reader.string());
}

export function parseChromiumFullVersion(value: string): ChromiumVersion {
  if (typeof value !== "string" || value !== value.trim() || !/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    invalid("Chromium version must be an exact canonical four-component version");
  }
  const components = value.split(".").map(Number);
  if (components.some((part) => !Number.isSafeInteger(part) || part > 0xffffffff)) invalid("Chromium version component is out of range");
  return { version: value, major: String(components[0]), tuple: components as [number, number, number, number] };
}
export function parseChromiumProductVersion(value: string): ChromiumProductVersion {
  const match = typeof value === "string" && /^(Chrome|Chromium|HeadlessChrome|HeadlessChromium)\/([^\s]+)$/.exec(value);
  if (!match || match[0] !== value) return invalid("Browser.getVersion.product must be one exact Chromium product/version tuple");
  return { ...parseChromiumFullVersion(match[2]), product: match[1] as ChromiumProductVersion["product"] };
}
/** Only the canonical #version element is accepted, never the page body or a substring. */
export function parseChromeVersionElement(value: string): ChromiumVersion {
  return parseChromiumFullVersion(value);
}
export function parseChromiumUserAgentVersion(value: string): ChromiumProductVersion {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) return invalid("User-Agent must be a bounded string without control characters");
  const matches = [...value.matchAll(/(?:^|[ \t])(Chrome|Chromium|HeadlessChrome|HeadlessChromium)\/([^\s()]+)(?=$|[ \t])/g)];
  if (matches.length !== 1) return invalid("User-Agent must contain exactly one Chromium product/version token");
  return parseChromiumProductVersion(`${matches[0][1]}/${matches[0][2]}`);
}

/** Chromium's GREASE spelling and version pools, not a catch-all for unknown brands. */
export function isChromiumGreaseBrand(value: ClientHintBrand): boolean {
  return value.brand === value.brand.trim() && value.version === value.version.trim() &&
    /^Not[ ():./;=?_\-]A[ ():./;=?_\-]Brand$/.test(value.brand) && /^(?:8|24|99)(?:\.0\.0\.0)?$/.test(value.version);
}
