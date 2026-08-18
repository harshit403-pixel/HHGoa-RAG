import express, { Request, Response } from 'express';
import Ok from '../responses/Ok.response.js';

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
    return Ok(res, 'Server is healthy', {
        status: 'UP',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

export default router;
