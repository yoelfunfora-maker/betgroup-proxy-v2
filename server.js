const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const firebaseServiceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';

if (!firebaseServiceAccountB64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 no definido');
  process.exit(1);
}

let serviceAccount;
try {
  const decoded = Buffer.from(firebaseServiceAccountB64, 'base64').toString('utf-8');
  serviceAccount = JSON.parse(decoded);
  console.log('✅ Firebase Admin SDK inicializado');
} catch (e) {
  console.error('❌ Error:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

app.get('/health', (req, res) => {
  res.json({ status: 'sync_completed', timestamp: new Date().toISOString() });
});

app.post('/sync', async (req, res) => {
  try {
    console.log('🔄 Sincronizando eventos...');
    
    const oddsApiKey1 = process.env.ODDS_API_KEY_1;
    const sports = ['soccer_epl', 'soccer_champions_league', 'baseball_mlb'];
    let eventosSync = {};

    for (const sport of sports) {
      try {
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/' + sport + '/events', {
          params: { apiKey: oddsApiKey1 }
        });

        if (response.data && Array.isArray(response.data)) {
          response.data.forEach(evento => {
            eventosSync[evento.id] = {
              nombre: evento.home_team + ' vs ' + evento.away_team,
              deporte: sport,
              fecha: evento.commence_time,
              actualizado: new Date().toISOString()
            };
          });
        }
      } catch (e) {
        console.error('Error en ' + sport + ':', e.message);
      }
    }

    if (Object.keys(eventosSync).length > 0) {
      await db.ref('eventos_sync').set(eventosSync);
      console.log('✅ ' + Object.keys(eventosSync).length + ' eventos sincronizados');
    }
    
    res.json({ status: 'sync_completed', eventos: Object.keys(eventosSync).length });

  } catch (e) {
    console.error('❌ Error sync:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/delete-user', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID requerido' });
    await auth.deleteUser(uid);
    await db.ref('users/' + uid).remove();
    await db.ref('apuestas/' + uid).remove();
    await db.ref('historial/' + uid).remove();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Proxy corriendo en ' + PORT));
