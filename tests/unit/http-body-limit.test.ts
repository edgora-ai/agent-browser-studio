import { describe, it, expect } from 'vitest';
import { readBody, HttpError } from '../../src/main/services/http/body.js';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
function mockReq(body: string, headers: Record<string,string> = {}): IncomingMessage {
  const r = new Readable({ read(){} }) as any;
  r.headers = headers;
  r.url = '/test';
  r.method = 'POST';
  process.nextTick(()=>{ r.push(Buffer.from(body)); r.push(null); });
  return r;
}
describe('http body limits',()=>{
  it('413 on Content-Length over max', async ()=>{
    const req = mockReq('x', {'content-length':'9999999'});
    await expect(readBody(req, {maxBytes:100})).rejects.toBeInstanceOf(HttpError);
  });
  it('413 on streaming over max', async ()=>{
    const req = mockReq('x'.repeat(200), {});
    await expect(readBody(req, {maxBytes:100})).rejects.toBeInstanceOf(HttpError);
  });
  it('reads within limit', async ()=>{
    const req = mockReq('hello', {});
    expect((await readBody(req, {maxBytes:100})).toString()).toBe('hello');
  });
});
