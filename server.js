const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const base64 = require('base-64');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Inicializar Firebase desde Base64
const firebaseServiceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';

if (!firebaseServiceAccountB64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 no definido');
  process.exit(1);
}

let serviceAccount;
try {
  const decoded = base64.decode(firebaseServiceAccountB64);
  serviceAccount = JSON.parse(decoded);
  console.log('✅ Firebase Admin SDK inicializado desde Base64');
} catch (e) {
  console.error('❌ Error decodificando Base64:', e);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

// ENDPOINTS

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'sync_completed', timestamp: new Date().toISOString() });
});

// Sync de cuotas desde The Odds API
app.post('/sync', async (req, res) => {
  try {
    console.log('🔄 Sincronizando cuotas...');

    const oddsApiKey1 = process.env.ODDS_API_KEY_1;
    const oddsApiKey2 = process.env.ODDS_API_KEY_2;

    if (!oddsApiKey1 || !oddsApiKey2) {
      return res.status(400).json({ error: 'API keys no definidas' });
    }

    // Obtener eventos de The Odds API
    const sports = ['soccer_epl', 'soccer_champions_league', 'baseball_mlb'];
    let eventosSync = {};

    for (const sport of sports) {
      try {
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/' + sport + '/events', {
          params: { apiKey: oddsApiKey1 }
        });

        response.data.forEach(evento => {
          eventosSync[evento.id] = {
            nombre: evento.home_team + ' vs ' + evento.away_team,
            deporte: sport,
            fecha: evento.commence_time,
            actualizado: new Date().toISOString()
          };
        });
      } catch (e) {
        console.error('Error sincronizando ' + sport + ':', e.message);
      }
    }

    // Guardar en RTDB
    await db.ref('eventos_sync').set(eventosSync);

    console.log('✅ ' + Object.keys(eventosSync).length + ' eventos sincronizados');
    res.json({ status: 'sync_completed', eventos: Object.keys(eventosSync).length });

  } catch (e) {
    console.error('❌ Error sync:', e);
    res.status(500).json({ error: e.message });
  }
});

// Eliminar usuario (para frontend)
app.post('/api/delete-user', async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'UID requerido' });
    }

    // Eliminar de Auth
    await auth.deleteUser(uid);

    // Eliminar de Database
    await db.ref('users/' + uid).remove();
    await db.ref('apuestas/' + uid).remove();
    await db.ref('historial/' + uid).remove();

    console.log('✅ Usuario ' + uid + ' eliminado');
    res.json({ success: true, message: 'Usuario eliminado' });

  } catch (e) {
    console.error('❌ Error delete-user:', e);
    res.status(500).json({ error: e.message });
  }
});

// Puerto
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('🚀 BetGroup Proxy V2 corriendo en puerto ' + PORT);
  console.log('📌 Health: /health');
  console.log('📌 Sync: POST /sync');
  console.log('📌 Delete: POST /api/delete-user');
});
