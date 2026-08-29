import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-facade-'));
vi.mock('electron', () => ({ app: { getPath:(n:string)=> TMP, isPackaged:false }, BrowserWindow:{getAllWindows:()=>[]}, session:{fromPartition:()=>({})}, dialog:{}, shell:{}}));
describe('profile-store facade',()=>{
  it('exposes list/get/set', async ()=>{
    const ps = await import('../../src/main/services/browser/profile-store.js');
    expect(typeof ps.listProfileMetas).toBe('function');
    expect(typeof ps.getProfileMetaFacade).toBe('function');
    fs.rmSync(TMP,{recursive:true,force:true});
  });
});
