import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger.config.js';

function errorHandler(
    err: Error & { statusCode?: number },
    req: Request,
    res: Response,
    next: NextFunction
) {
    logger.error(err);

    return res.status(err.statusCode || 500).json({
        success: false,
        status: err.statusCode || 500,
        message: err.message || 'Internal Server Error'
    });
}

export default errorHandler;
