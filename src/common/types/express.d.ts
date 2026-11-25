import type { Logger } from 'pino';
import type { AuthenticatedUser } from '@/common/types/http.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: AuthenticatedUser;
    }
  }
}

export {};
