export class Logger {
  constructor(private readonly scope: string) {}

  info(message: string, payload?: unknown): void {
    console.info(`[${this.scope}] ${message}`, payload ?? '');
  }

  warn(message: string, payload?: unknown): void {
    console.warn(`[${this.scope}] ${message}`, payload ?? '');
  }

  error(message: string, payload?: unknown): void {
    console.error(`[${this.scope}] ${message}`, payload ?? '');
  }
}
