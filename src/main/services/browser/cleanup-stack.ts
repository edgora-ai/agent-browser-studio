export class CleanupStack {
  private stack: Array<() => void | Promise<void>> = [];
  push(fn: () => void | Promise<void>): void { this.stack.push(fn); }
  async run(): Promise<void> {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      try { await this.stack[i](); } catch {}
    }
    this.stack = [];
  }
}
