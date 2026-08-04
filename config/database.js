// config/database.js — Connexion MySQL Hostinger
require('dotenv').config();
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME     || 'hapylogistic_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset: 'utf8mb4',
});
// Test de connexion au démarrage
// CORRECTION : en cas d'échec, l'erreur était journalisée mais le serveur
// continuait quand même à tourner (et à répondre 200 sur /health, qui ne
// teste pas la base) — avec une base injoignable, absolument aucune route
// ne fonctionne, mais rien ne le signalait clairement au démarrage. Même
// classe de problème que pour services/stripe.js (clé Stripe manquante) :
// mieux vaut un crash immédiat et explicite qu'un serveur qui tourne dans
// un état cassé sans que personne ne le sache avant qu'un utilisateur ne
// tombe sur une erreur 500 cryptique.
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connecté avec succès');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Erreur connexion MySQL:', err.message);
    console.error('❌ Le serveur ne peut pas fonctionner sans base de données — arrêt.');
    process.exit(1);
  });
module.exports = pool;
