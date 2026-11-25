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

const errorResponse = (
  description: string,
  schema: 'Error' | 'ValidationError' = 'Error',
): OpenAPIV3.ResponseObject => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
});

const outletEnvelope = responseEnvelope({
  type: 'object',
  required: ['outlet'],
  properties: { outlet: { $ref: '#/components/schemas/Outlet' } },
});

const outletIdParameter: OpenAPIV3.ParameterObject = {
  in: 'path',
  name: 'outletId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const staffEnvelope = responseEnvelope({
  type: 'object',
  required: ['staff'],
  properties: { staff: { $ref: '#/components/schemas/StaffDetail' } },
});

const staffIdParameter: OpenAPIV3.ParameterObject = {
  in: 'path',
  name: 'staffId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const hqAdminErrors: Record<string, OpenAPIV3.ResponseObject> = {
  '400': errorResponse('Invalid request', 'ValidationError'),
  '401': errorResponse('Authentication required'),
  '403': errorResponse('HQ_ADMIN role required'),
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'OutletHub API',
    version: '1.0.0',
    description: 'OutletHub authentication, health, outlet management, and staff management API.',
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
      ValidationError: {
        allOf: [
          { $ref: '#/components/schemas/Error' },
          {
            type: 'object',
            properties: {
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['message'],
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
        ],
      },
      Outlet: {
        type: 'object',
        required: ['id', 'code', 'name', 'address', 'isActive', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string', maxLength: 20, pattern: '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' },
          name: { type: 'string', maxLength: 150 },
          address: { type: 'string', maxLength: 500, nullable: true },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Pagination: {
        type: 'object',
        required: ['page', 'limit', 'total', 'totalPages'],
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          total: { type: 'integer', minimum: 0 },
          totalPages: { type: 'integer', minimum: 0 },
        },
      },
      StaffIdentity: {
        type: 'object',
        required: ['id', 'email', 'role', 'isActive', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email', maxLength: 320 },
          role: { type: 'string', enum: ['OUTLET_STAFF'] },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      StaffSummary: {
        allOf: [
          { $ref: '#/components/schemas/StaffIdentity' },
          {
            type: 'object',
            required: ['outletCount'],
            properties: { outletCount: { type: 'integer', minimum: 0 } },
          },
        ],
      },
      StaffDetail: {
        allOf: [
          { $ref: '#/components/schemas/StaffIdentity' },
          {
            type: 'object',
            required: ['outlets'],
            properties: {
              outlets: {
                type: 'array',
                description: 'Assigned outlets ordered by code, including inactive ones',
                items: {
                  type: 'object',
                  required: ['id', 'code', 'name', 'isActive'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    code: { type: 'string' },
                    name: { type: 'string' },
                    isActive: { type: 'boolean' },
                  },
                },
              },
            },
          },
        ],
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
    '/outlets': {
      get: {
        tags: ['Outlets'],
        summary: 'List outlets',
        description:
          'HQ_ADMIN sees all outlets. OUTLET_STAFF sees only active outlets they are assigned to; the restriction applies to items and the total count.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            in: 'query',
            name: 'search',
            description: 'Case-insensitive match on code or name',
            schema: { type: 'string', maxLength: 100 },
          },
          {
            in: 'query',
            name: 'status',
            schema: { type: 'string', enum: ['all', 'active', 'inactive'], default: 'all' },
          },
          {
            in: 'query',
            name: 'sortBy',
            schema: {
              type: 'string',
              enum: ['code', 'name', 'createdAt', 'updatedAt'],
              default: 'createdAt',
            },
          },
          {
            in: 'query',
            name: 'sortOrder',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        ],
        responses: {
          '200': {
            description: 'Outlets page',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['items', 'pagination'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/Outlet' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              }),
            },
          },
          '400': errorResponse('Invalid query parameters', 'ValidationError'),
          '401': errorResponse('Authentication required'),
        },
      },
      post: {
        tags: ['Outlets'],
        summary: 'Create an outlet and its receipt counter (HQ_ADMIN)',
        description:
          'The code is trimmed and uppercased and cannot be changed later. The outlet and its receipt counter (lastNumber 0) are created in one transaction.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'name'],
                properties: {
                  code: { type: 'string', minLength: 2, maxLength: 20, example: 'MIRPUR-01' },
                  name: { type: 'string', minLength: 1, maxLength: 150 },
                  address: { type: 'string', maxLength: 500, nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': outletEnvelope } },
          '400': errorResponse('Invalid body', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('HQ_ADMIN role required'),
          '409': errorResponse('Outlet code already exists', 'ValidationError'),
        },
      },
    },
    '/outlets/{outletId}': {
      parameters: [outletIdParameter],
      get: {
        tags: ['Outlets'],
        summary: 'Get outlet details',
        description:
          'HQ_ADMIN can read any outlet (404 if missing). OUTLET_STAFF can read only active outlets they are assigned to (403 otherwise).',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Outlet', content: { 'application/json': outletEnvelope } },
          '400': errorResponse('Invalid outlet id', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('No access to this outlet'),
          '404': errorResponse('Outlet not found'),
        },
      },
      patch: {
        tags: ['Outlets'],
        summary: 'Update outlet name or address (HQ_ADMIN)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 150 },
                  address: { type: 'string', maxLength: 500, nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated', content: { 'application/json': outletEnvelope } },
          '400': errorResponse('Invalid body or immutable field', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('HQ_ADMIN role required'),
          '404': errorResponse('Outlet not found'),
        },
      },
    },
    '/outlets/{outletId}/status': {
      parameters: [outletIdParameter],
      patch: {
        tags: ['Outlets'],
        summary: 'Activate or deactivate an outlet (HQ_ADMIN)',
        description:
          'Idempotent. Memberships, stock, sales and the receipt counter are preserved. Inactive outlets are excluded from staff access immediately.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['isActive'],
                properties: { isActive: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Status set', content: { 'application/json': outletEnvelope } },
          '400': errorResponse('Invalid body', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('HQ_ADMIN role required'),
          '404': errorResponse('Outlet not found'),
        },
      },
    },
    '/staff': {
      get: {
        tags: ['Staff'],
        summary: 'List outlet staff (HQ_ADMIN)',
        description: 'Returns OUTLET_STAFF accounts only; HQ administrators are never listed.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            in: 'query',
            name: 'search',
            description: 'Case-insensitive email match',
            schema: { type: 'string', maxLength: 100 },
          },
          {
            in: 'query',
            name: 'status',
            schema: { type: 'string', enum: ['all', 'active', 'inactive'], default: 'all' },
          },
          {
            in: 'query',
            name: 'outletId',
            description: 'Only staff assigned to this outlet',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            in: 'query',
            name: 'sortBy',
            schema: {
              type: 'string',
              enum: ['email', 'createdAt', 'updatedAt'],
              default: 'createdAt',
            },
          },
          {
            in: 'query',
            name: 'sortOrder',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        ],
        responses: {
          '200': {
            description: 'Staff page',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['items', 'pagination'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/StaffSummary' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              }),
            },
          },
          ...hqAdminErrors,
        },
      },
      post: {
        tags: ['Staff'],
        summary: 'Create an outlet staff account (HQ_ADMIN)',
        description:
          'Role is always OUTLET_STAFF and the account starts active. The user and all memberships are created in one transaction; every outlet must exist and be active.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email', maxLength: 320 },
                  password: {
                    type: 'string',
                    format: 'password',
                    writeOnly: true,
                    minLength: 12,
                    maxLength: 128,
                  },
                  outletIds: {
                    type: 'array',
                    uniqueItems: true,
                    maxItems: 200,
                    default: [],
                    items: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': staffEnvelope } },
          '409': errorResponse('Email already in use', 'ValidationError'),
          ...hqAdminErrors,
        },
      },
    },
    '/staff/{staffId}': {
      parameters: [staffIdParameter],
      get: {
        tags: ['Staff'],
        summary: 'Get a staff member with assigned outlets (HQ_ADMIN)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Staff member', content: { 'application/json': staffEnvelope } },
          '404': errorResponse('Not found or not an OUTLET_STAFF account'),
          ...hqAdminErrors,
        },
      },
      patch: {
        tags: ['Staff'],
        summary: 'Change a staff email (HQ_ADMIN)',
        description: 'The new email becomes the login identifier immediately. Sessions are kept.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['email'],
                properties: { email: { type: 'string', format: 'email', maxLength: 320 } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated', content: { 'application/json': staffEnvelope } },
          '404': errorResponse('Not found or not an OUTLET_STAFF account'),
          '409': errorResponse('Email already in use', 'ValidationError'),
          ...hqAdminErrors,
        },
      },
    },
    '/staff/{staffId}/status': {
      parameters: [staffIdParameter],
      patch: {
        tags: ['Staff'],
        summary: 'Activate or deactivate a staff account (HQ_ADMIN)',
        description:
          'Idempotent. Deactivation revokes every unrevoked refresh session (ADMIN_REVOKED) in the same transaction; access tokens are rejected on their next use because authentication re-checks is_active. Reactivation does not restore revoked sessions. Memberships and sales are preserved.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['isActive'],
                properties: { isActive: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Status set', content: { 'application/json': staffEnvelope } },
          '404': errorResponse('Not found or not an OUTLET_STAFF account'),
          ...hqAdminErrors,
        },
      },
    },
    '/staff/{staffId}/outlets': {
      parameters: [staffIdParameter],
      put: {
        tags: ['Staff'],
        summary: 'Replace outlet assignments (HQ_ADMIN)',
        description:
          'Idempotent replacement of the full membership set. Unchanged memberships are kept, removed ones deleted, added ones created; added outlets must exist and be active. Retained memberships to inactive outlets are allowed. Concurrent requests are serialized per staff member; the last one wins.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['outletIds'],
                properties: {
                  outletIds: {
                    type: 'array',
                    uniqueItems: true,
                    maxItems: 200,
                    items: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Assignments', content: { 'application/json': staffEnvelope } },
          '404': errorResponse('Not found or not an OUTLET_STAFF account'),
          ...hqAdminErrors,
        },
      },
    },
    '/staff/{staffId}/password': {
      parameters: [staffIdParameter],
      patch: {
        tags: ['Staff'],
        summary: 'Reset a staff password (HQ_ADMIN)',
        description:
          'Rate limited per administrator. Updates the Argon2id hash and revokes every unrevoked refresh session (ADMIN_REVOKED) in one transaction. Access tokens already issued stay valid until they expire (JWT_ACCESS_TTL_SECONDS, 15 minutes by default).',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['newPassword'],
                properties: {
                  newPassword: {
                    type: 'string',
                    format: 'password',
                    writeOnly: true,
                    minLength: 12,
                    maxLength: 128,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Password reset',
            content: { 'application/json': responseEnvelope({ type: 'object' }) },
          },
          '404': errorResponse('Not found or not an OUTLET_STAFF account'),
          '429': errorResponse('Too many password resets'),
          ...hqAdminErrors,
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
