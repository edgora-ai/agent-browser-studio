export type HttpMethod = "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"OPTIONS";
export interface RestRouteDefinition {
  method: HttpMethod;
  path: string;
  open?: boolean;
  handle: (ctx: any) => Promise<{status:number; body:any}>;
}
export class Router {
  private routes: RestRouteDefinition[] = [];
  register(r: RestRouteDefinition){ this.routes.push(r); }
  all(){ return this.routes; }
}
