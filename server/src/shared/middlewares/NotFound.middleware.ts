import { Request, Response, NextFunction } from 'express';
import NotFound from '../errors/NotFound.error.js';

function notFoundHandler(req: Request, res: Response, next: NextFunction) {
    throw new NotFound('Resource not found');
}

export default notFoundHandler;
