// ─────────────────────────────────────────────────────────────────────────────
//  HapyLogistic — emailService.js
//  Emails transactionnels via Resend
//  
//  Installation : npm install resend
//  Variable d'environnement requise : RESEND_API_KEY
//
//  Emails gérés :
//  1. sendBookingConfirmation    — client après paiement (avec code de collecte)
//  2. sendNewBookingToCarrier    — transporteur quand réservation reçue
//  3. sendPickupConfirmed        — client quand collecte confirmée par transporteur
//  4. sendDeliveryRequest        — client quand livraison marquée → demande confirmation
//  5. sendReceiptConfirmed       — transporteur quand réception confirmée → paiement envoyé
//  6. sendRefundNotification     — client en cas de remboursement
//  7. sendDisputeOpened          — équipe interne + transporteur quand litige ouvert
// ─────────────────────────────────────────────────────────────────────────────

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = 'HapyLogistic <noreply@hapylogistic.com>';
const SUPPORT_EMAIL = 'support@hapylogistic.com';
const BASE_URL = 'https://hapylogistic.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(amount) {
  const n = Number(amount);
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(isNaN(n) ? 0 : n);
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

// Template HTML de base — wrapper commun à tous les emails
function wrapEmail({ title, previewText, body }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#f5f5f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#1a1a2e; }
    .wrapper { max-width:600px; margin:0 auto; padding:32px 16px; }
    .card { background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.06); }
    .header { background:linear-gradient(135deg,#6c63ff,#4a90d9); padding:32px 40px; text-align:center; }
    .logo { color:#fff; font-size:24px; font-weight:800; letter-spacing:-0.5px; text-decoration:none; }
    .logo span { color:#c4b5fd; }
    .logo em { color:#fbbf24; font-style:normal; }
    .body { padding:40px; }
    h1 { font-size:24px; font-weight:800; color:#1a1a2e; margin-bottom:8px; }
    .subtitle { color:#6b7280; font-size:15px; margin-bottom:32px; }
    .section { margin-bottom:28px; }
    .section-title { font-size:12px; font-weight:700; color:#6c63ff; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }
    .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .info-item { background:#f9f9ff; border-radius:10px; padding:14px 16px; }
    .info-label { font-size:11px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
    .info-value { font-size:15px; font-weight:600; color:#1a1a2e; }
    .pickup-code { background:linear-gradient(135deg,#6c63ff15,#4a90d915); border:2px dashed #6c63ff40; border-radius:14px; padding:24px; text-align:center; margin:24px 0; }
    .pickup-code-label { font-size:12px; color:#6c63ff; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
    .pickup-code-value { font-size:36px; font-weight:900; color:#6c63ff; letter-spacing:8px; font-family:monospace; }
    .pickup-code-hint { font-size:12px; color:#9ca3af; margin-top:8px; }
    .btn { display:inline-block; background:#6c63ff; color:#fff !important; text-decoration:none; padding:14px 32px; border-radius:10px; font-weight:700; font-size:15px; margin-top:8px; }
    .btn-outline { background:transparent; color:#6c63ff !important; border:2px solid #6c63ff; }
    .alert { border-left:4px solid #6c63ff; background:#f0f0ff; border-radius:0 10px 10px 0; padding:16px 20px; margin:20px 0; font-size:14px; color:#4a3fa0; }
    .alert.success { border-color:#10b981; background:#f0fdf4; color:#065f46; }
    .alert.warning { border-color:#f59e0b; background:#fffbeb; color:#92400e; }
    .divider { border:none; border-top:1px solid #f3f4f6; margin:28px 0; }
    .footer { background:#f9f9ff; padding:24px 40px; text-align:center; }
    .footer p { font-size:12px; color:#9ca3af; line-height:1.8; }
    .footer a { color:#6c63ff; text-decoration:none; }
    .badge { display:inline-block; background:#6c63ff15; color:#6c63ff; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600; }
    @media(max-width:480px) { .body { padding:24px; } .info-grid { grid-template-columns:1fr; } .header { padding:24px; } }
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;">${previewText}</div>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <a href="${BASE_URL}" class="logo">Hapy<span>Logi</span><em>stic</em></a>
      </div>
      <div class="body">
        ${body}
      </div>
      <div class="footer">
        <p>
          © 2025 HapyLogistic · <a href="${BASE_URL}/pages/legal.html">Mentions légales</a> · <a href="${BASE_URL}/pages/legal.html?tab=privacy">Confidentialité</a><br>
          Des questions ? <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ── 1. Confirmation de réservation au client ──────────────────────────────────
// CORRECTION : utilisation des champs snake_case tels que retournés par MySQL
// (booking.weight_kg, listing.price_per_kg, listing.departure_date)
// + lecture directe des montants déjà calculés et stockés en BDD (booking.base_amount,
//   booking.client_fee, booking.client_total) plutôt que de les recalculer.

async function sendBookingConfirmation({ to, firstName, booking, listing, pickupCode }) {
  const weight       = booking.weight_kg ?? booking.weight;
  const base         = booking.base_amount;
  const clientFee    = booking.client_fee;
  const clientTotal  = booking.client_total;

  const html = wrapEmail({
    title: 'Votre réservation est confirmée — HapyLogistic',
    previewText: `Réservation confirmée ✅ Code de collecte : ${pickupCode}`,
    body: `
      <h1>Réservation confirmée ! 🎉</h1>
      <p class="subtitle">Bonjour ${firstName}, votre paiement est sécurisé. Voici les détails de votre envoi.</p>

      <div class="pickup-code">
        <div class="pickup-code-label">🔐 Code de collecte</div>
        <div class="pickup-code-value">${pickupCode}</div>
        <div class="pickup-code-hint">Donnez ce code au transporteur lors de la collecte de votre colis</div>
      </div>

      <div class="alert">
        <strong>Important :</strong> Conservez ce code précieusement. Le transporteur vous demandera ce code pour récupérer votre colis. Ne le partagez pas avant la collecte.
      </div>

      <div class="section">
        <div class="section-title">📦 Détails de l'envoi</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Départ</div>
            <div class="info-value">${listing.origin}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Destination</div>
            <div class="info-value">${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Date de départ</div>
            <div class="info-value">${formatDate(listing.departure_date)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Poids réservé</div>
            <div class="info-value">${weight} kg</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">💰 Récapitulatif de paiement</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Prix de base</div>
            <div class="info-value">${formatCurrency(base)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Frais de service</div>
            <div class="info-value">${formatCurrency(clientFee)}</div>
          </div>
          <div class="info-item" style="grid-column:1/-1;background:#6c63ff08;border:1px solid #6c63ff20">
            <div class="info-label">Total payé</div>
            <div class="info-value" style="font-size:18px;color:#6c63ff">${formatCurrency(clientTotal)}</div>
          </div>
        </div>
      </div>

      <div class="alert success">
        🔒 <strong>Paiement escrow Stripe :</strong> Votre argent est conservé en sécurité et ne sera versé au transporteur qu'après confirmation de la livraison.
      </div>

      <hr class="divider">

      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-client.html" class="btn">Voir ma réservation →</a>
      </div>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `✅ Réservation confirmée — Code de collecte : ${pickupCode}`,
    html,
  });
}

// ── 2. Nouvelle réservation au transporteur ───────────────────────────────────

async function sendNewBookingToCarrier({ to, carrierFirstName, booking, listing, client }) {
  const weight     = booking.weight_kg ?? booking.weight;
  const carrierNet = booking.carrier_net;

  const html = wrapEmail({
    title: 'Nouvelle réservation reçue — HapyLogistic',
    previewText: `${client.firstName} a réservé ${weight}kg sur votre trajet ${listing.origin} → ${listing.destination}`,
    body: `
      <h1>Nouvelle réservation ! 📬</h1>
      <p class="subtitle">Bonjour ${carrierFirstName}, vous avez reçu une nouvelle réservation sur votre annonce.</p>

      <div class="section">
        <div class="section-title">👤 Client</div>
        <div class="info-item" style="margin-bottom:0">
          <div class="info-value">${client.firstName} ${client.lastName}</div>
          <div class="info-label" style="margin-top:4px">${client.email}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">📦 Détails du colis</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Poids</div>
            <div class="info-value">${weight} kg</div>
          </div>
          <div class="info-item">
            <div class="info-label">Votre gain net</div>
            <div class="info-value" style="color:#10b981">${formatCurrency(carrierNet)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Trajet</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Date de départ</div>
            <div class="info-value">${formatDate(listing.departure_date)}</div>
          </div>
        </div>
      </div>

      ${booking.special_notes ? `
      <div class="section">
        <div class="section-title">📝 Description du colis</div>
        <div class="info-item">
          <div class="info-value" style="font-weight:400;font-size:14px;line-height:1.6">${booking.special_notes}</div>
        </div>
      </div>
      ` : ''}

      <div class="alert">
        <strong>Prochaine étape :</strong> Acceptez la réservation depuis votre tableau de bord pour confirmer la collecte. Le client vous communiquera le code de collecte lors de la remise du colis.
      </div>

      <hr class="divider">

      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-carrier.html" class="btn">Gérer mes réservations →</a>
      </div>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `📬 Nouvelle réservation — ${weight}kg · ${listing.origin} → ${listing.destination}`,
    html,
  });
}

// ── 3. Collecte confirmée → notification client ───────────────────────────────

async function sendPickupConfirmed({ to, firstName, booking, listing }) {
  const html = wrapEmail({
    title: 'Colis collecté — HapyLogistic',
    previewText: `Votre colis a été collecté et est en route vers ${listing.destination} 🚀`,
    body: `
      <h1>Colis collecté ! 🚀</h1>
      <p class="subtitle">Bonjour ${firstName}, votre colis a bien été pris en charge par le transporteur.</p>

      <div class="alert success">
        ✅ Le transporteur a confirmé la collecte de votre colis. Votre envoi est maintenant en route !
      </div>

      <div class="section">
        <div class="section-title">📍 Suivi de l'envoi</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Statut</div>
            <div class="info-value"><span class="badge">En transit</span></div>
          </div>
          <div class="info-item">
            <div class="info-label">Destination</div>
            <div class="info-value">${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Date de collecte</div>
            <div class="info-value">${formatDate(new Date().toISOString())}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Référence</div>
            <div class="info-value" style="font-size:13px;font-family:monospace">#${booking.id?.slice(0,8).toUpperCase()}</div>
          </div>
        </div>
      </div>

      <div class="alert">
        <strong>Rappel :</strong> Votre paiement reste bloqué en escrow Stripe jusqu'à ce que vous confirmiez la réception. Vous recevrez un email dès que le transporteur marque la livraison.
      </div>

      <hr class="divider">

      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-client.html" class="btn">Suivre mon envoi →</a>
      </div>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `🚀 Colis collecté — En route vers ${listing.destination}`,
    html,
  });
}

// ── 4. Livraison marquée → demande confirmation au client ─────────────────────

async function sendDeliveryRequest({ to, firstName, booking, listing }) {
  const weight = booking.weight_kg ?? booking.weight;

  const html = wrapEmail({
    title: 'Confirmez la réception de votre colis — HapyLogistic',
    previewText: `Le transporteur a marqué votre colis comme livré. Confirmez la réception pour libérer le paiement.`,
    body: `
      <h1>Votre colis est arrivé ! 📦</h1>
      <p class="subtitle">Bonjour ${firstName}, le transporteur a marqué votre envoi comme livré. Veuillez confirmer la réception.</p>

      <div class="alert warning">
        ⏳ <strong>Action requise :</strong> Vous avez <strong>48 heures</strong> pour confirmer ou contester la livraison. Sans action de votre part, le paiement sera automatiquement libéré au transporteur.
      </div>

      <div class="section">
        <div class="section-title">📦 Votre envoi</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Trajet</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Poids</div>
            <div class="info-value">${weight} kg</div>
          </div>
        </div>
      </div>

      <hr class="divider">

      <div style="text-align:center;margin-bottom:16px">
        <p style="margin-bottom:20px;color:#6b7280;font-size:14px">Le colis est bien arrivé en bon état ?</p>
        <a href="${BASE_URL}/pages/dashboard-client.html" class="btn" style="margin-right:12px">✅ Confirmer la réception</a>
      </div>
      <div style="text-align:center">
        <p style="font-size:13px;color:#9ca3af">Un problème ? <a href="${BASE_URL}/pages/dashboard-client.html" style="color:#ef4444;font-weight:600">Ouvrir un litige</a></p>
      </div>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `📦 Colis livré — Confirmez la réception pour libérer le paiement`,
    html,
  });
}

// ── 5. Réception confirmée → paiement envoyé au transporteur ─────────────────
// CORRECTION : la commission est lue depuis booking.platform_fee (déjà calculée
// et stockée en BDD) plutôt que recalculée depuis listing.pricePerKg (undefined)

async function sendReceiptConfirmed({ to, carrierFirstName, booking, listing, netAmount }) {
  const weight       = booking.weight_kg ?? booking.weight;
  const platformFee  = booking.platform_fee;

  const html = wrapEmail({
    title: 'Paiement en cours de virement — HapyLogistic',
    previewText: `Le client a confirmé la réception. Votre virement de ${formatCurrency(netAmount)} est en route !`,
    body: `
      <h1>Paiement en route ! 💸</h1>
      <p class="subtitle">Bonjour ${carrierFirstName}, le client a confirmé la réception du colis. Votre paiement est libéré.</p>

      <div class="alert success">
        ✅ La livraison est confirmée. Votre paiement a été déclenché et sera sur votre compte sous 2-3 jours ouvrés.
      </div>

      <div class="section">
        <div class="section-title">💰 Détails du paiement</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Trajet</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Poids transporté</div>
            <div class="info-value">${weight} kg</div>
          </div>
          <div class="info-item">
            <div class="info-label">Commission HapyLogistic</div>
            <div class="info-value" style="color:#ef4444">− ${formatCurrency(platformFee)}</div>
          </div>
          <div class="info-item" style="background:#f0fdf4;border:1px solid #bbf7d0">
            <div class="info-label">Montant net viré</div>
            <div class="info-value" style="color:#10b981;font-size:20px">${formatCurrency(netAmount)}</div>
          </div>
        </div>
      </div>

      <div class="alert">
        <strong>Délai :</strong> Le virement arrive sous 2-3 jours ouvrés selon votre banque. Vérifiez dans vos revenus sur votre tableau de bord.
      </div>

      <hr class="divider">

      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-carrier.html" class="btn">Voir mes revenus →</a>
      </div>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `💸 Paiement viré — ${formatCurrency(netAmount)} pour votre trajet ${listing.origin} → ${listing.destination}`,
    html,
  });
}

// ── 6. Remboursement au client ────────────────────────────────────────────────

async function sendRefundNotification({ to, firstName, booking, listing, refundAmount, reason }) {
  const html = wrapEmail({
    title: 'Remboursement en cours — HapyLogistic',
    previewText: `Votre remboursement de ${formatCurrency(refundAmount)} est en cours de traitement`,
    body: `
      <h1>Remboursement en cours 🔄</h1>
      <p class="subtitle">Bonjour ${firstName}, votre remboursement a bien été initié.</p>

      <div class="alert warning">
        🔄 Votre remboursement est en cours de traitement. Le montant apparaîtra sur votre relevé bancaire sous <strong>5 à 10 jours ouvrés</strong>.
      </div>

      <div class="section">
        <div class="section-title">💰 Détails du remboursement</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Montant remboursé</div>
            <div class="info-value" style="color:#10b981;font-size:18px">${formatCurrency(refundAmount)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Motif</div>
            <div class="info-value">${reason || 'Annulation'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Trajet annulé</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Référence</div>
            <div class="info-value" style="font-size:13px;font-family:monospace">#${booking.id?.slice(0,8).toUpperCase()}</div>
          </div>
        </div>
      </div>

      <hr class="divider">

      <p style="font-size:14px;color:#6b7280;text-align:center">Des questions sur votre remboursement ? Contactez-nous à <a href="mailto:${SUPPORT_EMAIL}" style="color:#6c63ff">${SUPPORT_EMAIL}</a></p>
    `
  });

  return resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `🔄 Remboursement de ${formatCurrency(refundAmount)} en cours`,
    html,
  });
}

// ── 7. Litige ouvert ──────────────────────────────────────────────────────────

async function sendDisputeOpened({ clientEmail, carrierEmail, client, carrier, booking, listing, reason }) {
  // Email au client
  const clientHtml = wrapEmail({
    title: 'Litige ouvert — HapyLogistic',
    previewText: `Votre litige a bien été ouvert. Notre équipe prend en charge dans les 48h.`,
    body: `
      <h1>Litige ouvert 🔍</h1>
      <p class="subtitle">Bonjour ${client.firstName}, votre litige a été enregistré. Notre équipe va l'examiner.</p>

      <div class="alert">
        📋 <strong>Numéro de litige :</strong> #${booking.id?.slice(0,8).toUpperCase()}<br>
        Notre équipe vous répondra dans les <strong>48 heures ouvrées</strong>.
      </div>

      <div class="section">
        <div class="section-title">📝 Détails du litige</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Motif</div>
            <div class="info-value">${reason}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Trajet concerné</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
        </div>
      </div>

      <p style="font-size:14px;color:#6b7280">Votre paiement reste bloqué en escrow Stripe jusqu'à résolution du litige.</p>

      <hr class="divider">
      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-client.html" class="btn">Voir mon litige →</a>
      </div>
    `
  });

  // Email au transporteur
  const carrierHtml = wrapEmail({
    title: 'Un litige a été ouvert — HapyLogistic',
    previewText: `${client.firstName} a ouvert un litige concernant votre trajet ${listing.origin} → ${listing.destination}`,
    body: `
      <h1>Litige ouvert 🔍</h1>
      <p class="subtitle">Bonjour ${carrier.firstName}, un client a ouvert un litige concernant l'un de vos trajets.</p>

      <div class="alert warning">
        ⚠️ <strong>Action requise :</strong> Notre équipe va examiner la situation. Votre paiement pour ce trajet est temporairement suspendu jusqu'à résolution.
      </div>

      <div class="section">
        <div class="section-title">📋 Détails</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Client</div>
            <div class="info-value">${client.firstName} ${client.lastName}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Motif déclaré</div>
            <div class="info-value">${reason}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Trajet</div>
            <div class="info-value">${listing.origin} → ${listing.destination}</div>
          </div>
        </div>
      </div>

      <p style="font-size:14px;color:#6b7280">Vous pouvez soumettre votre version des faits depuis votre tableau de bord. Notre équipe prend une décision sous 48h.</p>

      <hr class="divider">
      <div style="text-align:center">
        <a href="${BASE_URL}/pages/dashboard-carrier.html" class="btn">Répondre au litige →</a>
      </div>
    `
  });

  // Email interne à l'équipe support
  const supportHtml = `
    <h2>Nouveau litige #${booking.id?.slice(0,8).toUpperCase()}</h2>
    <p><strong>Client :</strong> ${client.firstName} ${client.lastName} (${clientEmail})</p>
    <p><strong>Transporteur :</strong> ${carrier.firstName} ${carrier.lastName} (${carrierEmail})</p>
    <p><strong>Trajet :</strong> ${listing.origin} → ${listing.destination}</p>
    <p><strong>Motif :</strong> ${reason}</p>
    <p><strong>Booking ID :</strong> ${booking.id}</p>
    <p><a href="https://dashboard.stripe.com">Voir dans Stripe Dashboard</a></p>
  `;

  await Promise.all([
    resend.emails.send({ from: FROM_EMAIL, to: clientEmail, subject: `🔍 Litige ouvert #${booking.id?.slice(0,8).toUpperCase()}`, html: clientHtml }),
    resend.emails.send({ from: FROM_EMAIL, to: carrierEmail, subject: `⚠️ Litige ouvert sur votre trajet ${listing.origin} → ${listing.destination}`, html: carrierHtml }),
    resend.emails.send({ from: FROM_EMAIL, to: SUPPORT_EMAIL, subject: `[LITIGE] #${booking.id?.slice(0,8).toUpperCase()} — ${client.firstName} vs ${carrier.firstName}`, html: supportHtml }),
  ]);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  sendBookingConfirmation,
  sendNewBookingToCarrier,
  sendPickupConfirmed,
  sendDeliveryRequest,
  sendReceiptConfirmed,
  sendRefundNotification,
  sendDisputeOpened,
};
