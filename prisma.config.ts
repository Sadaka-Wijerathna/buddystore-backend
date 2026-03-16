import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { PrismaNeonHttp } from '@prisma/adapter-neon';

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  migrate: {
    async adapter() {
      const connectionString = process.env.DATABASE_URL!;
      return new PrismaNeonHttp(connectionString, {});
    },
  },
});
