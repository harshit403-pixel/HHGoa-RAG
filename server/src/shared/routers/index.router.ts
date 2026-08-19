import express from 'express';
import healthRouter from './health.router.js';
import queryRouter from './query.router.js';

const router = express.Router();

router.use('/health', healthRouter);
router.use('/query', queryRouter);

export default router;
