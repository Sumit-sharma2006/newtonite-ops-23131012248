import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  TEST_DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  ROLL_NO: string;
}

export const env: AppEnv = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '4000', 10),
  DATABASE_URL:
    process.env.DATABASE_URL ||
    `postgres://${process.env.DB_USER || 'pressuredesk'}:${process.env.DB_PASSWORD || 'pressuredesk123'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pressuredesk'}`,
  TEST_DATABASE_URL:
    process.env.TEST_DATABASE_URL ||
    `postgres://${process.env.DB_USER || 'pressuredesk'}:${process.env.DB_PASSWORD || 'pressuredesk123'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/pressuredesk_test`,
  JWT_SECRET: process.env.JWT_SECRET || 'super-secret-pressuredesk-jwt-token-change-in-prod-2026',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
  ROLL_NO: process.env.ROLL_NO || '<rollno>'
};
