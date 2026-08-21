import pino from 'pino';
import env from './env.config.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let hasPinoPretty = false;
try {
    require.resolve('pino-pretty');
    hasPinoPretty = true;
} catch (e) {
    hasPinoPretty = false;
}

const logger = pino({
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    ...(env.NODE_ENV !== 'production' && hasPinoPretty && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname'
            }
        }
    })
});

export default logger;
