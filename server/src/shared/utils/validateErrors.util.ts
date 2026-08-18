import { validationResult } from 'express-validator';
import { Request, Response, NextFunction } from 'express';
import BadRequest from '../errors/BadRequest.error.js';

export const validateErrors = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const firstError = errors.array()[0];

        throw new BadRequest(firstError.msg);
    }

    next();
};

export default validateErrors;
