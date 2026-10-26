/**
 * FM-035 error taxonomy. FM-046's `reason_code` needs to tell "this chunk is
 * bad" from "the worker is down" — classified by TYPE, never by message text.
 */
export class EmbeddingWorkerError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingWorkerError';
  }
}
export class EmbeddingContentError extends Error {
  readonly retryable = false as const;
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingContentError';
  }
}
