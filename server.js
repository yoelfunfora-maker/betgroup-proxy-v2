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
  // Decodificar Base64 y parsear JSON directamente
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
