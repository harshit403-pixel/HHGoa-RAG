import express, { Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import router from './shared/routers/index.router.js';
import applyMiddlewares from './shared/middlewares/index.middleware.js';
import notFoundHandler from './shared/middlewares/NotFound.middleware.js';
import errorHandler from './shared/middlewares/error.middleware.js';
import { setupSwagger } from './shared/swagger.js';

const publicDirectory = path.resolve(process.cwd(), 'public');
const frontendIndex = path.join(publicDirectory, 'index.html');

function createApp(): Express {
    const app = express();

    applyMiddlewares(app);

    app.use('/api', router);
    app.use('/api', notFoundHandler);

    setupSwagger(app);

    if (existsSync(frontendIndex)) {
        app.use(express.static(publicDirectory));

        app.get('*', (req, res) => res.sendFile(frontendIndex));
    }

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

export default createApp;
