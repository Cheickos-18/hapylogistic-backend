// services/contentFilter.js — Filtrage des messages client ↔ transporteur
// ─────────────────────────────────────────────────────────────────────────────
// Deux logiques distinctes, volontairement différentes :
//
//  1. detectContactInfo()  → BLOQUE l'envoi (retour 400, message non inséré)
//     Cible : téléphones, emails, pseudos réseaux sociaux / apps de message.
//     Objectif : faire respecter les CGU §9 (anti-contournement). La remise
//     du colis n'exige aucun contact direct : elle passe par le code de
//     collecte à 4 chiffres généré par la plateforme (pickup_code).
//     NE BLOQUE PAS le texte libre (adresses postales, points de RDV, etc.) —
//     seuls des formats numériques/email reconnaissables déclenchent le blocage.
//
//  2. detectAbusiveLanguage() → SIGNALE seulement (le message est envoyé,
//     mais marqué is_flagged=1 pour revue humaine a posteriori).
//     On évite un blocage automatique ici : un filtre par mots-clés a un taux
//     de faux positifs trop élevé sur le langage familier/frustré, et bloquer
//     à tort un message légitime dégrade l'expérience. Mieux vaut modérer
//     après coup (avertissement, suspension) que de gêner les échanges normaux.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Coordonnées de contact (bloquant) ──────────────────────────────────────

// Numéros de téléphone : au moins 6 chiffres consécutifs, séparateurs courants
// tolérés (espace, point, tiret, parenthèses), avec ou sans indicatif pays.
const PHONE_REGEX = /(?:\+?\d[\s.\-()]?){6,}\d/g;

// Emails : format standard
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Mentions explicites d'appli de messagerie / réseaux sociaux utilisées pour
// sortir de la plateforme (WhatsApp, Telegram, Signal, Instagram, Snapchat...)
// accompagnées d'un identifiant probable (@pseudo, ou juste le nom de l'appli
// suivi de deux points/chiffres qui ressemblent à un contact).
const SOCIAL_APP_REGEX = /\b(whatsapp|watsapp|whats app|telegram|signal|snapchat|snap|instagram|insta)\b/i;
const HANDLE_REGEX = /@[a-zA-Z0-9_.]{3,}/g;

function stripDigitsNoise(s) {
  // Utilisé uniquement pour compter les chiffres "utiles" d'une correspondance
  // potentielle de téléphone, afin d'écarter les faux positifs courts
  // (ex: un numéro de rue "12" ou un code postal isolé de 5 chiffres ne
  // matche déjà pas le regex à 6+ chiffres, mais on double-vérifie ici).
  return (s.match(/\d/g) || []).length;
}

function detectContactInfo(text) {
  if (!text) return { blocked: false };

  const phoneMatches = text.match(PHONE_REGEX) || [];
  const realPhone = phoneMatches.find(m => stripDigitsNoise(m) >= 6);
  if (realPhone) {
    return {
      blocked: true,
      reason: 'phone',
      message: "Merci de ne pas partager de numéro de téléphone dans la messagerie. Toute la coordination (y compris la remise du colis) passe par HapyLogistic — utilisez le code de collecte fourni.",
    };
  }

  if (EMAIL_REGEX.test(text)) {
    return {
      blocked: true,
      reason: 'email',
      message: "Merci de ne pas partager d'adresse email dans la messagerie. Restez sur HapyLogistic pour toute communication.",
    };
  }

  if (SOCIAL_APP_REGEX.test(text) && HANDLE_REGEX.test(text)) {
    return {
      blocked: true,
      reason: 'social_handle',
      message: "Merci de ne pas partager d'identifiant de réseau social ou d'application externe. Toute la communication doit rester sur HapyLogistic.",
    };
  }

  return { blocked: false };
}

// ── 2. Langage abusif (signalement, pas de blocage) ───────────────────────────

// Liste volontairement limitée aux termes les plus francs (insultes directes,
// menaces explicites). Pas d'ambition d'exhaustivité — un filtre trop agressif
// génère plus de faux positifs que de valeur. Objectif : repérer les cas nets
// pour une revue humaine, pas remplacer la modération humaine.
const ABUSIVE_TERMS = [
  // Insultes directes
  'connard', 'connasse', 'salope', 'pute', 'enculé', 'enculé(e)', 'batard',
  'abruti', 'débile', 'idiot(e) de merde', 'sale race', 'sale nègre', 'sale arabe',
  'sale juif', 'nique ta mère', 'ntm',
  // Menaces explicites
  'je vais te tuer', 'je vais te retrouver', 'je vais te frapper',
  'je sais où tu habites', 'tu vas le regretter', 'tu vas payer pour ça',
];

function detectAbusiveLanguage(text) {
  if (!text) return { flagged: false };
  const lower = text.toLowerCase();
  const matched = ABUSIVE_TERMS.filter(term => lower.includes(term));
  if (matched.length) {
    return { flagged: true, reason: 'abusive_language', matchedCount: matched.length };
  }
  return { flagged: false };
}

module.exports = { detectContactInfo, detectAbusiveLanguage };
