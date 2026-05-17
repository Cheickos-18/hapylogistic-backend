# HapyLogistic — Guide de déploiement Hostinger

## Étapes dans l'ordre

---

### ÉTAPE 1 — Créer la base de données MySQL sur Hostinger

1. Allez sur **hPanel → Bases de données → MySQL**
2. Cliquez **"Créer une base de données"**
3. Notez :
   - Nom de la base : `hapylogistic_db`
   - Nom d'utilisateur MySQL
   - Mot de passe MySQL
4. Cliquez sur **phpMyAdmin**
5. Sélectionnez votre base → onglet **SQL**
6. Copiez-collez tout le contenu de `config/schema.sql`
7. Cliquez **Exécuter**

---

### ÉTAPE 2 — Mettre le code sur GitHub

1. Allez sur **github.com** → bouton vert **"New"**
2. Nom du dépôt : `hapylogistic-backend`
3. Visibilité : **Private**
4. Cliquez **"Create repository"**
5. Sur la page suivante, cliquez **"uploading an existing file"**
6. Glissez-déposez **tous les fichiers** du dossier `hapylogistic-backend`
   (sauf le dossier `node_modules` s'il existe)
7. Cliquez **"Commit changes"**

---

### ÉTAPE 3 — Déployer sur Hostinger

1. hPanel → **Sites web → Node.js → Commencer**
2. Connectez votre compte GitHub
3. Sélectionnez le dépôt `hapylogistic-backend`
4. Branche : `main`
5. Commande de démarrage : `npm start`
6. Cliquez **Deploy**

---

### ÉTAPE 4 — Configurer les variables d'environnement

Dans Hostinger, après le déploiement :
1. Cliquez sur votre application → **"Variables d'environnement"**
2. Ajoutez une par une :

```
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://votre-domaine.com

DB_HOST=localhost
DB_PORT=3306
DB_NAME=hapylogistic_db
DB_USER=votre_user_mysql
DB_PASSWORD=votre_mdp_mysql

JWT_SECRET=une_cle_tres_longue_et_secrete_ici
JWT_EXPIRES_IN=7d

STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

3. Cliquez **Save** → **Restart**

---

### ÉTAPE 5 — Vérifier que ça fonctionne

Ouvrez votre navigateur et allez sur :
```
https://votre-app.hostinger.com/health
```

Vous devriez voir :
```json
{"status":"ok","service":"HapyLogistic API","version":"1.0.0"}
```

---

### ÉTAPE 6 — Connecter le frontend au backend

Dans le fichier `js/shared.js` du frontend, remplacez :
```javascript
API_URL: 'https://api.hapylogistic.com',
```
par votre vraie URL Hostinger :
```javascript
API_URL: 'https://votre-app.hostinger.com',
```

---

### ÉTAPE 7 — Configurer Stripe Webhooks

1. Dashboard Stripe → **Webhooks → Ajouter un endpoint**
2. URL : `https://votre-app.hostinger.com/api/webhooks/stripe`
3. Événements à écouter :
   - `payment_intent.amount_capturable_updated`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `account.updated`
4. Copiez le **Signing secret** → ajoutez-le en variable d'env `STRIPE_WEBHOOK_SECRET`

---

## Carte de test Stripe

Pour tester sans vrai argent :
- Numéro : `4242 4242 4242 4242`
- Date : n'importe quelle date future
- CVC : `123`
