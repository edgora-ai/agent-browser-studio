import * as path from "node:path";

type DirectoryPaths = Pick<typeof path, "resolve" | "relative" | "dirname" | "isAbsolute" | "toNamespacedPath" | "sep">;

/** Newly created directories, deepest first. Pure path logic; never opens a share. */
export function createdDirectoryAncestry(directory: string, firstCreated: string, paths: DirectoryPaths = path): string[] {
  if (!paths.isAbsolute(directory) || !paths.isAbsolute(firstCreated)) throw new Error("Created directory boundary must be absolute");
  const target = paths.resolve(directory);
  // Windows mkdir returns an extended-length drive/UNC spelling. Compare both
  // paths in that namespace; retain the caller's spelling for subsequent I/O.
  const boundary = paths.toNamespacedPath(paths.resolve(firstCreated));
  const relative = paths.relative(boundary, paths.toNamespacedPath(target));
  if (relative === ".." || relative.startsWith(".." + paths.sep) || paths.isAbsolute(relative)) throw new Error("Created directory boundary is not an ancestor");
  const result: string[] = [];
  for (let at = target; ;) {
    result.push(at);
    if (paths.relative(boundary, paths.toNamespacedPath(at)) === "") return result;
    const parent = paths.dirname(at);
    if (parent === at) throw new Error("Created directory ancestry made no progress");
    at = parent;
  }
}
