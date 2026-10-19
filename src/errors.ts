/**
 * Framework error. `code` is the `DISPATCHKIT_*` prefix of the message, so
 * `error.code === "DISPATCHKIT_CQRS_GUARD"` works without parsing messages.
 */
export class DispatchkitError extends Error {
  readonly code: string;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = "DispatchkitError";
    this.code =
      options?.code ?? /^(DISPATCHKIT_[A-Z0-9_]+)/.exec(message)?.[1] ?? "DISPATCHKIT_ERROR";
  }
}
