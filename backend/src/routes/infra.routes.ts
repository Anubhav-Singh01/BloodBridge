import { Router } from 'express';
import { getHealth, getReady } from '../controllers/infra.controller.js';

export const infraRouter = Router();

infraRouter.get('/health', getHealth);
infraRouter.get('/ready', getReady);
