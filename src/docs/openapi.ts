import type { OpenAPIV3 } from 'openapi-types';

const responseEnvelope = (schema: OpenAPIV3.SchemaObject): OpenAPIV3.MediaTypeObject => ({
  schema: {
    type: 'object',
    required: ['success', 'message', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      message: { type: 'string' },
      data: schema,
    },
  },
});

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'OutletHub API',
    version: '1.0.0',
    description: 'Foundational authentication and health API.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'message', 'code', 'requestId'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string' },
          code: { type: 'string' },
          requestId: { type: 'string' },
        },
      },
      User: {
        type: 'object',
        required: ['id', 'email', 'role'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['HQ_ADMIN', 'OUTLET_STAFF'] },
        },
      },
    },
  },
  paths: {
    '/auth/login': {
      post: {
        summary: 'Authenticate with email and password',
        parameters: [
          {
            in: 'header',
            name: 'Origin',
            required: true,
            schema: { type: 'string', format: 'uri' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Authenticated; also sets the HttpOnly refresh cookie' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Rotate refresh token and issue access token',
        parameters: [{ in: 'header', name: 'Origin', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Rotated' }, '401': { description: 'Invalid session' } },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Revoke current refresh session',
        parameters: [{ in: 'header', name: 'Origin', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Revoked' } },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Get current user',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Current user' },
          '401': { description: 'Invalid access token' },
        },
      },
    },
    '/health/live': {
      get: {
        summary: 'Process liveness',
        responses: {
          '200': {
            description: 'Live',
            content: { 'application/json': responseEnvelope({ type: 'object' }) },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: 'Database-backed readiness',
        responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
      },
    },
  },
};
