// middleware/auth.js — Vérification JWT
const jwt = require('jsonwebtoken');
const db  = require('../config/database');

module.exports = async (req, res, next) => {
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

    // CORRECTION : révocation de session — sans ceci, un compte supprimé au
    // sens RGPD (routes/gdpr.js, droit à l'effacement art. 17) restait
    // pleinement utilisable via l'API tant que son token n'avait pas expiré
    // naturellement (jusqu'à 7 jours), même si le mot de passe et les
    // données personnelles étaient déjà anonymisés en base. La table
    // token_blacklist est alimentée par routes/gdpr.js au moment de la
    // suppression du compte ; on la vérifie ici à chaque requête
    // authentifiée pour couper l'accès immédiatement.
    const [blacklisted] = await db.execute(
      'SELECT 1 FROM token_blacklist WHERE user_id = ? LIMIT 1',
      [req.user.id]
    );
    if (blacklisted.length) {
      console.warn(`[auth] Accès refusé — utilisateur ${req.user.id} révoqué (compte supprimé)`);
      return res.status(401).json({ error: 'Ce compte a été supprimé' });
    }

    next();
  } catch (err) {
    // CORRECTION : le catch était totalement silencieux — aucune requête
    // avec un token invalide ou falsifié ne laissait de trace, rendant
    // impossible la détection de tentatives d'accès frauduleuses répétées.
    console.error('[auth] Token rejeté:', err.message);
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};
