export type ErrorDetail = {
  field?: string;
  message: string;
  meta?: Record<string, string | number>;
};

export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly errors?: ErrorDetail[],
    public readonly operational = true,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }
}

export class BadRequestError extends AppError {
  public constructor(message = 'Bad request', code = 'BAD_REQUEST', errors?: ErrorDetail[]) {
    super(400, code, message, errors);
  }
}

export class AuthenticationError extends AppError {
  public constructor(message = 'Authentication failed') {
    super(401, 'AUTHENTICATION_ERROR', message);
  }
}

export class AuthorizationError extends AppError {
  public constructor(message = 'You do not have permission to perform this action') {
    super(403, 'AUTHORIZATION_ERROR', message);
  }
}

export class NotFoundError extends AppError {
  public constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  public constructor(message = 'Resource conflict', errors?: ErrorDetail[]) {
    super(409, 'CONFLICT', message, errors);
  }
}
