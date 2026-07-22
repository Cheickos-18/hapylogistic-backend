// middleware/requireAdmin.js — Restreint une route aux comptes role='admin'
// À utiliser TOUJOURS après le middleware `auth` (qui pose req.user).
// Usage : router.get('/route', auth, requireAdmin, handler)

module.exports = function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Réservé aux administrateurs' });
  }
  next();
};
