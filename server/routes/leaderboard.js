import express from 'express';

export function createLeaderboardRouter({ service } = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const result = await service.read(req.session?.userId ?? null);
    res.json({ data: result });
  });

  return router;
}
