const axios = require('axios');
const admin = require('firebase-admin');

async function syncApiFootballEmergency() {
  console.log('🚨 SYNC EMERGENCIA: API-Football...');
  
  const apiKey = process.env.API_FOOTBALL_KEY || '668bf5165fd2f45ad1cdcee2ee30483e';
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  
  if (!apiKey) return console.error('❌ API_FOOTBALL_KEY falta');
  if (!serviceAccountBase64) return console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 falta');
  
  const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
    });
  }
  
  const db = admin.database();
  
  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': apiKey },
      params: { status: 'NS,1H,2H', next: 14 },
      timeout: 10000
    });
    
    let count = 0;
    for (const match of response.data?.response || []) {
      const { fixture, teams, odds, league } = match;
      if (!teams?.home || !teams?.away || !odds?.[0]) continue;
      
      const mercado = {
        id: fixture.id.toString(),
        sport: 'soccer',
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        commenceTime: fixture.date,
        cuotas: {
          local: odds[0].odds?.find(o => o.name === '1')?.odd || null,
          visitante: odds[0].odds?.find(o => o.name === '2')?.odd || null,
          empate: odds[0].odds?.find(o => o.name === 'X')?.odd || null
        },
        expiraEn: new Date(fixture.date).getTime() + 7200000,
        ligaOdds: league?.name || 'Soccer'
      };
      
      await db.ref(`mercados/${fixture.id}`).set(mercado);
      count++;
    }
    
    return `✅ ${count} mercados sincronizados`;
  } catch(e) {
    return `❌ Error: ${e.message}`;
  }
}

module.exports = { syncApiFootballEmergency };
