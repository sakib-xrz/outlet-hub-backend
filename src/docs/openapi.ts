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

const menuItemEnvelope = responseEnvelope({
  type: 'object',
  required: ['menuItem'],
  properties: { menuItem: { $ref: '#/components/schemas/MenuItem' } },
});

const menuItemIdParameter: OpenAPIV3.ParameterObject = {
  in: 'path',
  name: 'menuItemId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const outletMenuItemEnvelope = responseEnvelope({
  type: 'object',
  required: ['outletMenuItem'],
  properties: { outletMenuItem: { $ref: '#/components/schemas/OutletMenuItem' } },
});

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'OutletHub API',
    version: '1.0.0',
    description:
      'OutletHub authentication, health, outlet management, staff management, and master menu API. Monetary amounts are decimal strings with exactly two fraction digits in a single currency.',
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
      Money: {
        type: 'string',
        pattern: '^(0|[1-9]\\d{0,9})(\\.\\d{1,2})?$',
        description:
          'Non-negative decimal string, at most 2 fraction digits, max 9999999999.99. Requests may omit trailing zeros ("5", "5.5"); responses always use exactly two ("5.00"). JSON numbers, exponents, signs and NaN/Infinity are rejected.',
        example: '250.00',
      },
      MenuItem: {
        type: 'object',
        required: [
          'id',
          'sku',
          'name',
          'description',
          'basePrice',
          'isActive',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          sku: { type: 'string', maxLength: 50, pattern: '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' },
          name: { type: 'string', maxLength: 150 },
          description: { type: 'string', maxLength: 1000, nullable: true },
          basePrice: { $ref: '#/components/schemas/Money' },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      OutletMenuItem: {
        type: 'object',
        description:
          'An outlet assignment of a master menu item (unique per outlet). effectivePrice = overridePrice ?? basePrice. isEnabled = outletIsActive && menuItemIsActive && isActive; isSellable = isEnabled && stockQuantity > 0.',
        required: [
          'outletId',
          'menuItemId',
          'sku',
          'name',
          'description',
          'basePrice',
          'overridePrice',
          'effectivePrice',
          'priceSource',
          'stockQuantity',
          'isActive',
          'outletIsActive',
          'menuItemIsActive',
          'isEnabled',
          'isSellable',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          outletId: { type: 'string', format: 'uuid' },
          menuItemId: { type: 'string', format: 'uuid' },
          sku: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          basePrice: { $ref: '#/components/schemas/Money' },
          overridePrice: {
            allOf: [{ $ref: '#/components/schemas/Money' }],
            nullable: true,
            description:
              'null means the master base price is used; "0.00" is a valid explicit price',
          },
          effectivePrice: { $ref: '#/components/schemas/Money' },
          priceSource: { type: 'string', enum: ['BASE', 'OVERRIDE'] },
          stockQuantity: { type: 'integer', minimum: 0, description: 'Read-only in this phase' },
          isActive: { type: 'boolean', description: 'Assignment status' },
          outletIsActive: { type: 'boolean' },
          menuItemIsActive: { type: 'boolean', description: 'Master menu item status' },
          isEnabled: { type: 'boolean' },
          isSellable: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      InventoryItem: {
        type: 'object',
        description:
          'Stock of one outlet assignment. stockStatus: OUT_OF_STOCK (0), LOW (1–10), IN_STOCK (>10). Stock status is independent of sales availability (isEnabled / isSellable).',
        required: [
          'outletId',
          'menuItemId',
          'sku',
          'name',
          'stockQuantity',
          'stockStatus',
          'isActive',
          'outletIsActive',
          'menuItemIsActive',
          'isEnabled',
          'isSellable',
          'updatedAt',
        ],
        properties: {
          outletId: { type: 'string', format: 'uuid' },
          menuItemId: { type: 'string', format: 'uuid' },
          sku: { type: 'string' },
          name: { type: 'string' },
          stockQuantity: { type: 'integer', minimum: 0, maximum: 2147483647 },
          stockStatus: { type: 'string', enum: ['OUT_OF_STOCK', 'LOW', 'IN_STOCK'] },
          isActive: { type: 'boolean', description: 'Assignment status' },
          outletIsActive: { type: 'boolean' },
          menuItemIsActive: { type: 'boolean' },
          isEnabled: { type: 'boolean' },
          isSellable: { type: 'boolean' },
          updatedAt: { type: 'string', format: 'date-time' },
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
    '/menu-items': {
      get: {
        tags: ['Master menu'],
        summary: 'List master menu items (HQ_ADMIN)',
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
            description: 'Case-insensitive match on SKU or name',
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
              enum: ['sku', 'name', 'basePrice', 'createdAt', 'updatedAt'],
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
            description: 'Menu items page',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['items', 'pagination'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/MenuItem' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              }),
            },
          },
          ...hqAdminErrors,
        },
      },
      post: {
        tags: ['Master menu'],
        summary: 'Create a master menu item (HQ_ADMIN)',
        description:
          'SKU is trimmed and uppercased and cannot be changed later. Items start active and are not assigned to any outlet.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['sku', 'name', 'basePrice'],
                properties: {
                  sku: { type: 'string', minLength: 1, maxLength: 50, example: 'COFFEE-001' },
                  name: { type: 'string', minLength: 1, maxLength: 150, example: 'Cappuccino' },
                  description: { type: 'string', maxLength: 1000, nullable: true },
                  basePrice: { $ref: '#/components/schemas/Money' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': menuItemEnvelope } },
          '409': errorResponse('SKU already exists (field body.sku)', 'ValidationError'),
          ...hqAdminErrors,
        },
      },
    },
    '/menu-items/{menuItemId}': {
      parameters: [menuItemIdParameter],
      get: {
        tags: ['Master menu'],
        summary: 'Get a master menu item (HQ_ADMIN)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Menu item', content: { 'application/json': menuItemEnvelope } },
          '404': errorResponse('Menu item not found'),
          ...hqAdminErrors,
        },
      },
      patch: {
        tags: ['Master menu'],
        summary: 'Update name, description or base price (HQ_ADMIN)',
        description:
          'Partial update. SKU and status cannot be changed here. Outlet price overrides and historical sale prices are not affected.',
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
                  description: { type: 'string', maxLength: 1000, nullable: true },
                  basePrice: { $ref: '#/components/schemas/Money' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated', content: { 'application/json': menuItemEnvelope } },
          '404': errorResponse('Menu item not found'),
          ...hqAdminErrors,
        },
      },
    },
    '/menu-items/{menuItemId}/status': {
      parameters: [menuItemIdParameter],
      patch: {
        tags: ['Master menu'],
        summary: 'Activate or deactivate a master menu item (HQ_ADMIN)',
        description:
          'Idempotent conditional update. Inactive items must not be sold even if an outlet assignment is active. Outlet assignments, stock, price overrides and sales are preserved.',
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
          '200': { description: 'Status set', content: { 'application/json': menuItemEnvelope } },
          '404': errorResponse('Menu item not found'),
          ...hqAdminErrors,
        },
      },
    },
    '/outlets/{outletId}/menu-items': {
      parameters: [outletIdParameter],
      get: {
        tags: ['Outlet menu'],
        summary: "List an outlet's menu",
        description:
          'HQ_ADMIN: every assignment of any existing outlet (404 if the outlet is missing). OUTLET_STAFF: only for active outlets they belong to (403 otherwise), and only enabled items (outlet, master item and assignment all active), including enabled items with zero stock.',
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
            description: 'Case-insensitive match on master SKU or name',
            schema: { type: 'string', maxLength: 100 },
          },
          {
            in: 'query',
            name: 'status',
            description: 'Assignment status',
            schema: { type: 'string', enum: ['all', 'active', 'inactive'], default: 'all' },
          },
          {
            in: 'query',
            name: 'sortBy',
            schema: {
              type: 'string',
              enum: ['sku', 'name', 'createdAt', 'updatedAt'],
              default: 'name',
            },
          },
          {
            in: 'query',
            name: 'sortOrder',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          },
        ],
        responses: {
          '200': {
            description: 'Outlet menu page',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['items', 'pagination'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/OutletMenuItem' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              }),
            },
          },
          '400': errorResponse('Invalid parameters', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('No access to this outlet'),
          '404': errorResponse('Outlet not found'),
        },
      },
      post: {
        tags: ['Outlet menu'],
        summary: 'Assign a master menu item to the outlet (HQ_ADMIN)',
        description:
          'Outlet and master item must exist and be active. Stock starts at 0 and the assignment is active. One assignment per (outlet, menu item): an existing one, active or inactive, returns 409 (reactivate inactive ones via /status).',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['menuItemId'],
                properties: {
                  menuItemId: { type: 'string', format: 'uuid' },
                  overridePrice: {
                    allOf: [{ $ref: '#/components/schemas/Money' }],
                    nullable: true,
                    default: null,
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Assigned',
            content: { 'application/json': outletMenuItemEnvelope },
          },
          '404': errorResponse('Outlet not found'),
          '409': errorResponse(
            'Already assigned, outlet inactive, or master item inactive',
            'ValidationError',
          ),
          ...hqAdminErrors,
        },
      },
    },
    '/outlets/{outletId}/menu-items/{menuItemId}': {
      parameters: [outletIdParameter, menuItemIdParameter],
      get: {
        tags: ['Outlet menu'],
        summary: 'Get one outlet menu assignment',
        description:
          'Looked up by the (outletId, menuItemId) pair. Staff without outlet access get 403; staff with access get 404 for unassigned or disabled items.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Assignment',
            content: { 'application/json': outletMenuItemEnvelope },
          },
          '400': errorResponse('Invalid ids', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('No access to this outlet'),
          '404': errorResponse('Outlet or assignment not found'),
        },
      },
    },
    '/outlets/{outletId}/menu-items/{menuItemId}/price': {
      parameters: [outletIdParameter, menuItemIdParameter],
      patch: {
        tags: ['Outlet menu'],
        summary: 'Set or clear the outlet price override (HQ_ADMIN)',
        description:
          'Updates only override_price. null restores the master base price (future base price changes then apply). Allowed on inactive assignments and outlets. Stock, status and sales are untouched.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['overridePrice'],
                properties: {
                  overridePrice: {
                    allOf: [{ $ref: '#/components/schemas/Money' }],
                    nullable: true,
                  },
                },
              },
              examples: {
                override: { value: { overridePrice: '300.00' } },
                inherit: { value: { overridePrice: null } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: { 'application/json': outletMenuItemEnvelope },
          },
          '404': errorResponse('Outlet or assignment not found'),
          ...hqAdminErrors,
        },
      },
    },
    '/outlets/{outletId}/menu-items/{menuItemId}/status': {
      parameters: [outletIdParameter, menuItemIdParameter],
      patch: {
        tags: ['Outlet menu'],
        summary: 'Activate or deactivate an assignment (HQ_ADMIN)',
        description:
          'Idempotent (no write when unchanged). Deactivation is a soft unassignment and is always allowed. Reactivation requires an active outlet and master item. Stock and overrides are preserved; nothing is deleted.',
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
          '200': {
            description: 'Status set',
            content: { 'application/json': outletMenuItemEnvelope },
          },
          '404': errorResponse('Outlet or assignment not found'),
          '409': errorResponse('Cannot reactivate while the outlet or master item is inactive'),
          ...hqAdminErrors,
        },
      },
    },
    '/outlets/{outletId}/inventory': {
      parameters: [outletIdParameter],
      get: {
        tags: ['Inventory'],
        summary: "List an outlet's inventory",
        description:
          'HQ_ADMIN: every assignment of any existing outlet, including inactive assignments and inactive master items. OUTLET_STAFF: only active outlets they belong to (403 otherwise) and only enabled items, zero stock included.',
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
            description: 'Case-insensitive match on master SKU or name',
            schema: { type: 'string', maxLength: 100 },
          },
          {
            in: 'query',
            name: 'status',
            description: 'Assignment status',
            schema: { type: 'string', enum: ['all', 'active', 'inactive'], default: 'all' },
          },
          {
            in: 'query',
            name: 'stockStatus',
            description: 'out_of_stock = 0, low = 1–10, in_stock = more than 10',
            schema: {
              type: 'string',
              enum: ['all', 'out_of_stock', 'low', 'in_stock'],
              default: 'all',
            },
          },
          {
            in: 'query',
            name: 'sortBy',
            schema: {
              type: 'string',
              enum: ['sku', 'name', 'stockQuantity', 'updatedAt'],
              default: 'name',
            },
          },
          {
            in: 'query',
            name: 'sortOrder',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          },
        ],
        responses: {
          '200': {
            description: 'Inventory page',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['items', 'pagination'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              }),
            },
          },
          '400': errorResponse('Invalid parameters', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('No access to this outlet'),
          '404': errorResponse('Outlet not found'),
        },
      },
    },
    '/outlets/{outletId}/inventory/{menuItemId}': {
      parameters: [outletIdParameter, menuItemIdParameter],
      get: {
        tags: ['Inventory'],
        summary: 'Get the stock of one outlet menu item',
        description:
          'Looked up by the (outletId, menuItemId) pair. Staff with outlet access get 404 for unassigned or disabled items.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Inventory item',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: ['inventoryItem'],
                properties: { inventoryItem: { $ref: '#/components/schemas/InventoryItem' } },
              }),
            },
          },
          '400': errorResponse('Invalid ids', 'ValidationError'),
          '401': errorResponse('Authentication required'),
          '403': errorResponse('No access to this outlet'),
          '404': errorResponse('Outlet or assignment not found'),
        },
      },
    },
    '/outlets/{outletId}/inventory/{menuItemId}/adjust': {
      parameters: [outletIdParameter, menuItemIdParameter],
      patch: {
        tags: ['Inventory'],
        summary: 'Adjust stock (HQ_ADMIN)',
        description:
          'Runs in one transaction: locks the acting admin (FOR SHARE), the outlet (FOR SHARE, must be active) and the assignment (FOR UPDATE), computes the new balance from the locked row, and updates only stock_quantity. Stock stays within 0–2147483647. INCREASE and DECREASE are not idempotent: do not resend after an ambiguous failure; re-read the stock first. SET is guarded by expectedStockQuantity. Inactive assignments and inactive master items can be corrected while the outlet is active.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['operation', 'quantity'],
                    properties: {
                      operation: { type: 'string', enum: ['INCREASE', 'DECREASE'] },
                      quantity: { type: 'integer', minimum: 1, maximum: 2147483647 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['operation', 'quantity', 'expectedStockQuantity'],
                    properties: {
                      operation: { type: 'string', enum: ['SET'] },
                      quantity: { type: 'integer', minimum: 0, maximum: 2147483647 },
                      expectedStockQuantity: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 2147483647,
                        description: 'Stock the administrator saw; 409 STOCK_CHANGED if it differs',
                      },
                    },
                  },
                ],
              },
              examples: {
                increase: { value: { operation: 'INCREASE', quantity: 20 } },
                decrease: { value: { operation: 'DECREASE', quantity: 15 } },
                set: { value: { operation: 'SET', quantity: 40, expectedStockQuantity: 50 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Adjusted (or unchanged for a SET to the same value)',
            content: {
              'application/json': responseEnvelope({
                type: 'object',
                required: [
                  'inventoryItem',
                  'operation',
                  'previousStockQuantity',
                  'newStockQuantity',
                  'changed',
                ],
                properties: {
                  inventoryItem: { $ref: '#/components/schemas/InventoryItem' },
                  operation: { type: 'string', enum: ['INCREASE', 'DECREASE', 'SET'] },
                  previousStockQuantity: { type: 'integer' },
                  newStockQuantity: { type: 'integer' },
                  changed: { type: 'boolean' },
                },
              }),
            },
          },
          '404': errorResponse('Outlet or assignment not found'),
          '409': errorResponse(
            'Codes: OUTLET_INACTIVE, STOCK_CHANGED (stale expectedStockQuantity), INSUFFICIENT_STOCK, STOCK_LIMIT_EXCEEDED, CONCURRENT_UPDATE',
          ),
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
