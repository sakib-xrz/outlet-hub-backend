import type { Logger } from 'pino';
import type { AuthenticatedUser } from '@/common/types/http.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: AuthenticatedUser;
      validated?: { body?: unknown; params?: unknown; query?: unknown };
    }
  }
}

export {};
