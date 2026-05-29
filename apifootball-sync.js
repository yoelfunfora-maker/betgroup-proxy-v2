const axios = require('axios');
const admin = require('firebase-admin');

async function syncApiFootballToFirebase() {
  try {
    console.log('🔄 Sincronizando API-Football a Firebase...');
    
    const apiKey = process.env.API_FOOTBALL_KEY;
    if (!apiKey) {
      console.error('❌ API_FOOTBALL_KEY no definida');
      return;
    }
    
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!serviceAccountBase64) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 no definida');
      return;
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
      });
    }
    
    const db = admin.database();
    
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': apiKey },
      params: { 
        status: 'NS,1H,2H',
        next: 14
      },
      timeout: 10000
    });
    
    if (!response.data?.response) {
      console.log('❌ Sin datos de API-Football');
      return;
    }
    
    let count = 0;
    
    for (const match of response.data.response) {
      const fixture = match.fixture;
      const teams = match.teams;
      const odds = match.odds;
      
      if (!teams?.home || !teams?.away) continue;
      if (!odds || odds.length === 0) continue;
      
      const firstOdd = odds[0];
      
      const mercado = {
        id: fixture.id.toString(),
        sport: 'soccer',
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        commenceTime: fixture.date,
        cuotas: {
          local: firstOdd.odds?.find(o => o.name === '1')?.odd || null,
          visitante: firstOdd.odds?.find(o => o.name === '2')?.odd || null,
          empate: firstOdd.odds?.find(o => o.name === 'X')?.odd || null
        },
        expiraEn: new Date(fixture.date).getTime() + 7200000,
        ligaOdds: match.league?.name || 'Soccer'
      };
      
      await db.ref(`mercados/${fixture.id}`).set(mercado);
      count++;
    }
    
    console.log(`✅ ${count} mercados sincronizados`);
    
  } catch(e) {
    console.error('❌ Error API-Football:', e.message);
  }
}

module.exports = { syncApiFootballToFirebase };
