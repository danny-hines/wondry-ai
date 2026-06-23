// Public profile list (kiosk reads this for the user switcher).
import express from 'express';
import { db } from '../db.js';

export const router = express.Router();

router.get('/profiles', (req, res) => {
  const rows = db.prepare('SELECT id,name,initials,color,age,reading_level,theme FROM profiles ORDER BY name').all();
  res.json({ profiles: rows });
});

export default router;
