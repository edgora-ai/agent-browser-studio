// Exact authoring API in release-manifest.mjs:32-94,109-132.
// The parser normalizes optional fields; the author always supplies a hash/date.
export interface AuthoredRelease {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
  publishedAt: string;
  minSupported?: string;
}
export interface AuthoredManifest {
  product: 'agent-browser-studio';
  channel?: string;
  releases: AuthoredRelease[];
}
export interface BuildManifestOptions {
  file: string;
  version: string;
  baseUrl?: string;
  notes?: string;
  minSupported?: string;
  channel?: string;
  publishedAt?: string;
  // Existing parser-compatible entries may omit sha256/publishedAt. They are
  // retained unchanged by buildManifest, not upgraded to authored entries.
  existing?: ExistingManifest;
}
export interface ExistingRelease {
  version: string;
  url: string;
  sha256?: string;
  notes?: string;
  publishedAt?: string;
  minSupported?: string;
}
export interface ExistingManifest {
  product?: string;
  channel?: string;
  releases: ExistingRelease[];
}
export interface MergedManifest {
  product: 'agent-browser-studio';
  channel?: string;
  releases: ExistingRelease[];
}
export function sha256File(filePath: string): string;
export function compareVersionsDesc(a: string, b: string): number;
export function buildManifest(opts: BuildManifestOptions & { existing: ExistingManifest }): MergedManifest;
export function buildManifest(opts: BuildManifestOptions & { existing?: undefined }): AuthoredManifest;
export function buildManifest(opts: BuildManifestOptions): MergedManifest;
// CLI JSON input is not schema-validated before old entries are retained.
// Do not promote runCli's parsed/merged manifest to a validated transport DTO.
export function runCli(argv: string[]): { manifest: unknown; outPath: string; top: unknown };
