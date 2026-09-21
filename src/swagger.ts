import swaggerJsdoc from 'swagger-jsdoc';
import config from './config';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BuddyStore API',
      version: '1.0.0',
      description: 'API Documentation for BuddyStore Backend',
    },
    servers: [
      {
        url: config.webhookBaseUrl ? `${config.webhookBaseUrl}/api/v1` : 'http://localhost:4000/api/v1',
        description: 'BuddyStore API',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token in the format: Bearer <token>',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  // Look for JSDoc comments in all route files
  apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
