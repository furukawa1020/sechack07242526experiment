export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function conflict(message: string, code = "INVALID_STATE"): HttpError {
  return new HttpError(409, message, code);
}

export function badRequest(message: string, code = "INVALID_INPUT"): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message: string, code = "NOT_FOUND"): HttpError {
  return new HttpError(404, message, code);
}
