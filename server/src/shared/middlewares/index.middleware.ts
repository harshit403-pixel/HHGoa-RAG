import express, { Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import env from '../config/env.config.js';

function applyMiddlewares(app: Express) {
    app.use(compression());
    app.use(cors());
    app.use(helmet());
    app.use(hpp());
    app.use(cookieParser());
    app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
    app.use(express.json({ limit: '100kb' }));
    app.use(express.urlencoded({ extended: true, limit: '100kb' }));
}

export default applyMiddlewares;
