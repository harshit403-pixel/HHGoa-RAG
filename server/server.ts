import createApp from './src/app.js';
import env from './src/shared/config/env.config.js';
import logger from './src/shared/config/logger.config.js';
import { warmupSearcher } from './src/shared/controllers/query.controller.js';

async function startServer() {
    const app = createApp();

    app.listen(env.PORT || 5000, () => {
        logger.info(`Server is running on port ${env.PORT || 5000}`);
        warmupSearcher();
    });
}

startServer();
