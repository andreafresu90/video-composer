export class NotImplementedError extends Error {
  constructor(
    readonly step: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(`Step not implemented: ${step}`);
    this.name = 'NotImplementedError';
  }
}
