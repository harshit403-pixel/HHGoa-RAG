import { config } from 'dotenv';
import z from 'zod';
import envConstants from '../constants/env.constants.js';

config();

const envSchema = z.object({
    PORT: z.coerce.number().default(envConstants.PORT),
    NODE_ENV: z.enum(['development', 'production', 'test']).default(envConstants.NODE_ENV),
    CORS_ORIGIN: z.string().default(envConstants.CORS_ORIGIN),
    MISTRAL_API_KEY: z.string().optional(),
    SARVAM_API_KEY: z.string().optional(),
    INDEX_ROOT: z.string().default('/data/hhgoa/indexes')
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
    console.error('Invalid environment variables:', parsedEnv.error.format());
    process.exit(1);
}

const env = parsedEnv.data;

export default env;
