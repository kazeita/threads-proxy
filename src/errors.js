// Error with an HTTP status, thrown by the platform fetchers (Threads, Reddit).
export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}
