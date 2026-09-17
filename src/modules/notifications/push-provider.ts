export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * Three outcomes, because each demands different handling:
 *   DEVICE_NOT_REGISTERED — the app was uninstalled; reap the token.
 *   TRANSIENT             — retry the job.
 *   INVALID               — our fault; retrying cannot help.
 */
export type PushFailure = 'DEVICE_NOT_REGISTERED' | 'TRANSIENT' | 'INVALID';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Carried to the client so tapping the notification opens the right screen. */
  data?: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  error?: PushFailure;
}

/**
 * The transport boundary, and deliberately one method.
 *
 * It returns per-message results rather than throwing: a batch routinely
 * succeeds partially, and a thrown error would lose which tokens survived.
 */
export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/**
 * Thrown inside the push processor purely to make BullMQ retry. It is not a
 * DomainError: nothing here ever reaches an HTTP client, so it has no place in
 * the client-facing error contract.
 */
export class PushSendError extends Error {}
