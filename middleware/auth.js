// middleware/auth.js — Vérification JWT
const jwt = require('jsonwebtoken');
module.exports = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    const token = auth.split(' ')[1];
    // CORRECTION : restreindre explicitement l'algorithme accepté (bonne
    // pratique standard — évite de laisser la bibliothèque faire confiance
    // à l'algorithme déclaré dans le token lui-même). À ajuster si le
    // token est signé avec un autre algorithme que HS256.
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    // CORRECTION : le catch était totalement silencieux — aucune requête
    // avec un token invalide ou falsifié ne laissait de trace, rendant
    // impossible la détection de tentatives d'accès frauduleuses répétées.
    console.error('[auth] Token rejeté:', err.message);
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};
