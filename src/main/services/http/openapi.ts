export function buildOpenApi(opts: { title: string; version: string; baseUrl: string; routes: Array<{ method: string; path: string; open?: boolean }> }): any {
  return {
    openapi: "3.0.0",
    info: { title: opts.title, version: opts.version },
    servers: [{ url: opts.baseUrl }],
    paths: Object.fromEntries(opts.routes.map(r => [r.path, { [r.method.toLowerCase()]: { summary: r.path, security: r.open ? [] : undefined } }])),
  };
}
