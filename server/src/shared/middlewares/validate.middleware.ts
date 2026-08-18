import { Request, Response, NextFunction } from 'express';
import BadRequest from '../errors/BadRequest.error.js';

function validate(schema: { safeParse?: (data: unknown) => { success: boolean } }) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!schema) return next();
        const result = schema.safeParse ? schema.safeParse(req.body) : { success: true };
        if (!result.success) {
            throw new BadRequest('Validation failed');
        }
        next();
    };
}

export default validate;
