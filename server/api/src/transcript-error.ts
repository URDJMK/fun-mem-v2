/** Why a transcript could not be read. `code` lets the UI say it in the user's language. */
export type TranscriptErrorCode =
  'empty' | 'too_long' | 'too_many_segments' | 'unreadable' | 'no_speech';

export class TranscriptError extends Error {
  constructor(
    message: string,
    readonly code: TranscriptErrorCode = 'unreadable',
  ) {
    super(message);
  }
}
