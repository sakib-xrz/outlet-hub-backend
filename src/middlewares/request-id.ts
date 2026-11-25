import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const validRequestId = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestId: RequestHandler = (request, response, next) => {
  const supplied = request.header('x-request-id');
  request.id = supplied && validRequestId.test(supplied) ? supplied : randomUUID();
  response.setHeader('x-request-id', request.id);
  next();
};
