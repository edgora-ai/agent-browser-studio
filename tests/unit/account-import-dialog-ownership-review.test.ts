// Closed renderer facade: only the current accounts.js text is read from disk.
// No app import, real DOM, IPC, database, network, child process, timer or write.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const SOURCE = path.resolve(__dirname, '../../src/renderer/js/app/accounts.js');
const script = fs.readFileSync(SOURCE, 'utf8');
const flush = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
type Result = { added: number; created?: number; skipped: number; errors: { line: number; error: string }[] };
type Mode = 'bulkAdd' | 'bulkCreate';
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class Element {
  value = ''; innerHTML = ''; checked = false; disabled = false; open = false;
  style: Record<string, string> = {}; listeners: Record<string, Function[]> = {};
  closeCount = 0; showCount = 0;
  addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
  emit(type: string) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  showModal() { this.open = true; ++this.showCount; }
  close() { if (!this.open) return; this.open = false; ++this.closeCount; this.emit('close'); }
  cancel() { if (!this.open) return; this.emit('cancel'); this.close(); }
  closeWithoutEvent() { this.open = false; ++this.closeCount; }
}
function harness(mode: Mode = 'bulkAdd') {
  const elements = new Map([
    'dlg-account-import', 'acct-import-text', 'acct-import-status', 'acct-import-create-profiles',
    'acct-import-create-options', 'acct-import-platform',
  ].map(id => [id, new Element()] as const));
  const el = (id: string) => elements.get(id)!;
  const button = new Element(), cancel = new Element();
  const document = {
    getElementById: (id: string) => elements.get(id) || null,
    querySelector(selector: string) {
      if (selector === '#dlg-account-import [data-cmd="agentRunAccountImport"]') return button;
      if (selector === '#dlg-account button[type="submit"]' || selector === '#dlg-account-bind [data-cmd="agentSaveAccountBind"]') return null;
      throw new Error('Unexpected selector: ' + selector);
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-cmd="agentAddAccount"]') return [];
      throw new Error('Unexpected selector: ' + selector);
    },
  };
  const success: Result = { added: 1, created: 1, skipped: 0, errors: [] };
  const operation = vi.fn((_text: string, _options?: { platform?: string }): Promise<Result> => Promise.resolve(success));
  const otherOperation = vi.fn((_text: string, _options?: { platform?: string }): Promise<Result> => Promise.resolve(success));
  const role = vi.fn((): Promise<any> => Promise.resolve({ local: { role: 'owner' } }));
  const toast = vi.fn();
  const agent: any = {
    api: { team: { status: role } },
    R: { agent: { accounts: { [mode]: operation, [mode === 'bulkAdd' ? 'bulkCreate' : 'bulkAdd']: otherOperation } } },
    helpers: { toast, esc: String, escAttr: String, icon: () => '' }, state: { currentTab: 'accounts' },
  };
  vm.runInNewContext(script, { window: { agentBrowser: agent }, document }, {
    filename: SOURCE, timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  });
  // Refreshes are observable boundaries, not imports of list/profile modules.
  agent.agentLoadAccounts = vi.fn(); agent.loadAccountsTab = vi.fn(); agent.loadProfiles = vi.fn();
  const dialog = el('dlg-account-import'), input = el('acct-import-text'), status = el('acct-import-status');
  const profiles = el('acct-import-create-profiles'), platform = el('acct-import-platform');
  const open = async (draft = 'synthetic draft') => {
    await agent.agentImportAccounts(); input.value = draft;
    profiles.checked = mode === 'bulkCreate'; platform.value = 'windows'; profiles.emit('change');
  };
  const submit = () => agent.agentRunAccountImport();
  const expectNoRefresh = () => {
    expect(agent.agentLoadAccounts).not.toHaveBeenCalled(); expect(agent.loadAccountsTab).not.toHaveBeenCalled();
    expect(agent.loadProfiles).not.toHaveBeenCalled();
  };
  const expectCurrentRefresh = () => {
    expect(agent.agentLoadAccounts).toHaveBeenCalledTimes(1); expect(agent.loadAccountsTab).toHaveBeenCalledTimes(1);
    if (mode === 'bulkCreate') expect(agent.loadProfiles).toHaveBeenCalledWith(true);
    else expect(agent.loadProfiles).not.toHaveBeenCalled();
  };
  return { agent, el, button, cancel, dialog, input, status, profiles, platform, operation, otherOperation,
    role, toast, open, submit, success, expectNoRefresh, expectCurrentRefresh };
}

for (const mode of ['bulkAdd', 'bulkCreate'] as const) describe(mode + ' import dialog ownership', () => {
  it('never dispatches a submit from a closed dialog', async () => {
    const h = harness(mode); await h.submit(); await h.open(); h.dialog.close(); await h.submit();
    expect(h.operation).not.toHaveBeenCalled(); expect(h.otherOperation).not.toHaveBeenCalled();
    expect(h.button.disabled).toBe(false); h.expectNoRefresh();
  });

  it('single-flights repeated clicks and direct calls, captures one payload, then applies current success', async () => {
    const h = harness(mode), pending = deferred(); h.operation.mockReturnValueOnce(pending.promise);
    await h.open('first draft'); const submitted = h.submit(); h.submit(); h.submit(); await flush();
    expect(h.operation).toHaveBeenCalledTimes(1); expect(h.otherOperation).not.toHaveBeenCalled();
    expect(h.button.disabled).toBe(true); expect(h.cancel.disabled).toBe(false);
    h.button.disabled = false; h.input.value = 'edited while pending'; await h.submit();
    expect(h.operation).toHaveBeenCalledTimes(1);
    if (mode === 'bulkCreate') expect(h.operation).toHaveBeenCalledWith('first draft', { platform: 'windows' });
    else expect(h.operation).toHaveBeenCalledWith('first draft');
    pending.resolve(h.success); await submitted;
    expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(false);
    expect(h.status.innerHTML).toContain('Added 1 account');
    expect(h.toast).toHaveBeenCalledWith(mode === 'bulkCreate' ? 'Added 1 account, created 1 profile' : 'Added 1 account', 'success');
    h.expectCurrentRefresh();
  });

  for (const failure of ['reject', 'throw'] as const) it(failure + ' releases only this session, preserves input and allows retry', async () => {
    const h = harness(mode); await h.open('keep this draft');
    if (failure === 'reject') h.operation.mockRejectedValueOnce(new Error('synthetic rejection'));
    else h.operation.mockImplementationOnce(() => { throw new Error('synthetic throw'); });
    await h.submit();
    expect(h.dialog.open).toBe(true); expect(h.input.value).toBe('keep this draft');
    expect(h.profiles.checked).toBe(mode === 'bulkCreate'); expect(h.platform.value).toBe('windows');
    expect(h.status.innerHTML).toContain(failure === 'reject' ? 'synthetic rejection' : 'synthetic throw');
    expect(h.status.innerHTML).toContain('var(--danger-text)'); expect(h.button.disabled).toBe(false);
    expect(h.toast).not.toHaveBeenCalled(); h.expectNoRefresh();
    await h.submit(); expect(h.operation).toHaveBeenCalledTimes(2); expect(h.dialog.open).toBe(false);
    h.expectCurrentRefresh();
  });

  for (const dismiss of ['cancel', 'close'] as const) for (const late of ['success', 'reject'] as const)
    it(dismiss + ' A, reopen pending B: late A ' + late + '/finally cannot write, close, refresh or unlock B', async () => {
      const h = harness(mode), old = deferred(), next = deferred();
      h.operation.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      await h.open('A draft'); const a = h.submit(); await flush();
      expect(h.operation).toHaveBeenCalledTimes(1); h.dialog[dismiss]();
      await h.open('B draft'); const b = h.submit(); await flush();
      expect(h.operation).toHaveBeenCalledTimes(2); expect(h.button.disabled).toBe(true);
      const bStatus = h.status.innerHTML;
      if (late === 'reject') old.reject(new Error('obsolete A error'));
      else old.resolve({ added: 7, created: 7, skipped: 2, errors: [] });
      await a;
      expect(h.dialog.open).toBe(true); expect(h.dialog.closeCount).toBe(1);
      expect(h.input.value).toBe('B draft'); expect(h.status.innerHTML).toBe(bStatus);
      expect(h.button.disabled).toBe(true); expect(h.toast).not.toHaveBeenCalled(); h.expectNoRefresh();
      await h.submit(); expect(h.operation).toHaveBeenCalledTimes(2);
      next.resolve(h.success); await b;
      expect(h.dialog.open).toBe(false); expect(h.dialog.closeCount).toBe(2); expect(h.button.disabled).toBe(false);
      expect(h.toast).toHaveBeenCalledTimes(1); h.expectCurrentRefresh();
    });

  for (const late of ['success', 'reject'] as const) it('closing does not cancel backend work or apply late ' + late + ' to closed UI', async () => {
    const h = harness(mode), pending = deferred(); h.operation.mockReturnValueOnce(pending.promise);
    await h.open('closed draft'); const submitted = h.submit(); await flush();
    h.dialog.close(); const oldStatus = h.status.innerHTML; await h.submit();
    if (late === 'reject') pending.reject(new Error('closed error')); else pending.resolve(h.success);
    await submitted;
    expect(h.operation).toHaveBeenCalledTimes(1); expect(h.dialog.closeCount).toBe(1);
    expect(h.status.innerHTML).toBe(oldStatus); expect(h.toast).not.toHaveBeenCalled(); h.expectNoRefresh();
    await h.agent.agentImportAccounts();
    expect(h.dialog.open).toBe(true); expect(h.input.value).toBe(''); expect(h.status.innerHTML).toBe('');
    expect(h.profiles.checked).toBe(false); expect(h.platform.value).toBe(''); expect(h.button.disabled).toBe(false);
    expect(h.el('acct-import-create-options').style.display).toBe('none');
  });

  it('an opener command on the already-open pending dialog cannot reset its owner or draft', async () => {
    const h = harness(mode), pending = deferred(); h.operation.mockReturnValueOnce(pending.promise);
    await h.open('owned draft'); const submitted = h.submit(); await flush();
    const status = h.status.innerHTML; await h.agent.agentImportAccounts(); await h.submit();
    expect(h.dialog.showCount).toBe(1); expect(h.input.value).toBe('owned draft'); expect(h.status.innerHTML).toBe(status);
    expect(h.button.disabled).toBe(true); expect(h.operation).toHaveBeenCalledTimes(1);
    pending.resolve(h.success); await submitted;
  });

  it('preserves aggregate partial-success feedback and refreshes only the current owner', async () => {
    const h = harness(mode); await h.open();
    h.operation.mockResolvedValueOnce({ added: 1, created: 1, skipped: 2, errors: [{ line: 3, error: 'synthetic skipped row' }] });
    await h.submit();
    const msg = 'Added 1 account' + (mode === 'bulkCreate' ? ', created 1 profile' : '') + ', skipped 2';
    expect(h.status.innerHTML).toContain(msg); expect(h.toast).toHaveBeenCalledWith(msg, 'success');
    expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(false); h.expectCurrentRefresh();
  });

  it('zero additions report skipped/error feedback without closing or refreshing and remain retryable', async () => {
    const h = harness(mode); await h.open('retry skipped draft');
    h.operation.mockResolvedValueOnce({ added: 0, created: 0, skipped: 2, errors: [{ line: 1, error: 'synthetic invalid row' }] });
    await h.submit();
    expect(h.toast).toHaveBeenCalledWith('Added 0 accounts, skipped 2', 'error');
    expect(h.status.innerHTML).toContain('Added 0 accounts, skipped 2');
    expect(h.dialog.open).toBe(true); expect(h.input.value).toBe('retry skipped draft'); expect(h.button.disabled).toBe(false);
    h.expectNoRefresh(); await h.submit(); expect(h.operation).toHaveBeenCalledTimes(2); expect(h.dialog.open).toBe(false);
  });
});

describe('account import role and queued-dialog boundaries', () => {
  for (const authority of ['viewer', 'malformed', 'reject'] as const) it(authority + ' authority fails closed before opening or dispatching', async () => {
    const h = harness();
    if (authority === 'reject') h.role.mockRejectedValueOnce(new Error('synthetic unavailable role'));
    else h.role.mockResolvedValueOnce(authority === 'viewer' ? { local: { role: 'viewer' } } : {});
    await h.agent.agentImportAccounts(); await h.submit();
    expect(h.dialog.open).toBe(false); expect(h.operation).not.toHaveBeenCalled(); expect(h.button.disabled).toBe(false);
    expect(h.toast).toHaveBeenCalledWith('Accounts are read-only for viewers', 'error'); h.expectNoRefresh();
  });

  it('retains the role generation fence for a pending opener and permits a fresh authorized opener', async () => {
    const h = harness(), pending = deferred(); h.role.mockReturnValueOnce(pending.promise);
    const opening = h.agent.agentImportAccounts(); await flush(); h.agent.invalidateAccountsForSync();
    pending.resolve({ local: { role: 'owner' } }); await opening;
    expect(h.dialog.open).toBe(false); expect(h.operation).not.toHaveBeenCalled();
    await h.agent.agentImportAccounts(); expect(h.dialog.open).toBe(true); expect(h.role).toHaveBeenCalledTimes(2);
  });

  it('retains the role generation fence for a pending submit', async () => {
    const h = harness(), pending = deferred(); await h.open('role-owned draft');
    h.agent.invalidateAccountsForSync(); h.role.mockReturnValueOnce(pending.promise);
    const submitted = h.submit(); await flush(); h.agent.invalidateAccountsForSync();
    pending.resolve({ local: { role: 'owner' } }); await submitted;
    expect(h.operation).not.toHaveBeenCalled(); expect(h.input.value).toBe('role-owned draft');
    expect(h.status.innerHTML).toBe(''); expect(h.button.disabled).toBe(false); h.expectNoRefresh();
  });

  it('a role-waiting submit cannot migrate from a closed A session into reopened B', async () => {
    const h = harness(), pending = deferred(); await h.open('A draft');
    h.agent.invalidateAccountsForSync(); h.role.mockReturnValueOnce(pending.promise);
    const submitted = h.submit(); await flush(); h.dialog.close(); const opening = h.agent.agentImportAccounts();
    pending.resolve({ local: { role: 'owner' } }); await Promise.all([submitted, opening]);
    expect(h.dialog.open).toBe(true); expect(h.dialog.showCount).toBe(2); expect(h.input.value).toBe('');
    expect(h.operation).not.toHaveBeenCalled(); expect(h.button.disabled).toBe(false); h.expectNoRefresh();
  });

  it('only the latest pending opener may initialize the dialog after shared role lookup', async () => {
    const h = harness(), pending = deferred(); h.role.mockReturnValueOnce(pending.promise);
    const a = h.agent.agentImportAccounts(), b = h.agent.agentImportAccounts(); await flush();
    pending.resolve({ local: { role: 'owner' } }); await Promise.all([a, b]);
    expect(h.role).toHaveBeenCalledTimes(1); expect(h.dialog.showCount).toBe(1); expect(h.input.value).toBe('');
    expect(h.operation).not.toHaveBeenCalled();
  });

  for (const mode of ['bulkAdd', 'bulkCreate'] as const) for (const dismiss of ['close', 'cancel'] as const)
    it(mode + ' ' + dismiss + ' A: queued close cannot revoke B while its opener awaits a new role', async () => {
      const h = harness(mode), old = deferred(), pendingRole = deferred();
      h.operation.mockReturnValueOnce(old.promise);
      await h.open('A draft'); const a = h.submit(); await flush();
      if (dismiss === 'cancel') h.dialog.emit('cancel');
      h.dialog.closeWithoutEvent(); h.agent.invalidateAccountsForSync();
      h.role.mockReturnValueOnce(pendingRole.promise);
      const opening = h.agent.agentImportAccounts(); await flush();
      expect(h.dialog.open).toBe(false); expect(h.role).toHaveBeenCalledTimes(2);
      expect(h.dialog.showCount).toBe(1); expect(h.button.disabled).toBe(false);
      h.dialog.emit('close'); old.resolve({ added: 7, created: 7, skipped: 0, errors: [] }); await a;
      expect(h.toast).not.toHaveBeenCalled(); h.expectNoRefresh();
      pendingRole.resolve({ local: { role: 'owner' } }); await opening;
      expect(h.dialog.open).toBe(true); expect(h.dialog.showCount).toBe(2);
      expect(h.input.value).toBe(''); expect(h.status.innerHTML).toBe(''); expect(h.button.disabled).toBe(false);
      h.input.value = 'B draft'; h.profiles.checked = mode === 'bulkCreate'; h.platform.value = 'macos';
      await h.submit(); expect(h.operation).toHaveBeenCalledTimes(2); expect(h.dialog.open).toBe(false);
      if (mode === 'bulkCreate') expect(h.operation).toHaveBeenLastCalledWith('B draft', { platform: 'macos' });
      else expect(h.operation).toHaveBeenLastCalledWith('B draft');
      expect(h.toast).toHaveBeenCalledTimes(1); h.expectCurrentRefresh();
    });

  it('a queued native close event from A does not invalidate already-reopened pending B', async () => {
    const h = harness(), old = deferred(), next = deferred();
    h.operation.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await h.open('A draft'); const a = h.submit(); await flush(); h.dialog.closeWithoutEvent();
    await h.open('B draft'); const b = h.submit(); await flush(); h.dialog.emit('close');
    old.resolve(h.success); await a;
    expect(h.dialog.open).toBe(true); expect(h.input.value).toBe('B draft'); expect(h.button.disabled).toBe(true);
    expect(h.toast).not.toHaveBeenCalled(); h.expectNoRefresh();
    next.resolve(h.success); await b; expect(h.dialog.open).toBe(false); h.expectCurrentRefresh();
  });
});
