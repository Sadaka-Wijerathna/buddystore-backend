import { Router } from 'express';
import * as publicController from '../controllers/public.controller';

const router = Router();

// Special Bot Collections (Trending Videos)
router.get('/special-collections', publicController.getPublicSpecialCollections);

export default router;
