const https = require('https');

function fetchESPN(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy());
    req.end();
  });
}

export default async (req, res) => {
  try {
    const deportes = [
      { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
      { path: 'basketball/nba/scoreboard', sport: 'basketball' },
      { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
      { path: 'mma/ufc/scoreboard', sport: 'mma' }
    ];

    let allEvents = [];
    const ahora = Date.now();
    const dentro14dias = ahora + (14 * 24 * 60 * 60 * 1000);

    for (const deporte of deportes) {
      try {
        const data = await fetchESPN(deporte.path);
        if (!data.events) continue;

        for (const ev of data.events) {
          const competition = ev.competitions?.[0];
          if (!competition) continue;
          
          const competitors = competition.competitors || [];
          const eventTime = new Date(ev.date || 0).getTime();
          
          if (eventTime < ahora || eventTime > dentro14dias) continue;

          const status = ev.status?.type;
          const isLive = status?.state === 'in';
          const isScheduled = status?.state === 'pre';
          
          if (!isLive && !isScheduled) continue;

          if (deporte.sport === 'mma') {
            if (competitors.length < 2) continue;
            allEvents.push({
              id: ev.id,
              sport: 'mma',
              local: competitors[0].athlete?.displayName || 'Fighter 1',
              visitante: competitors[1].athlete?.displayName || 'Fighter 2',
              liga: data.leagues?.[0]?.name || 'UFC',
              horaInicio: ev.date
            });
          } else {
            const home = competitors.find(c => c.homeAway === 'home');
            const away = competitors.find(c => c.homeAway === 'away');
            if (!home || !away) continue;

            allEvents.push({
              id: ev.id,
              sport: deporte.sport,
              local: home.team?.displayName || 'Local',
              visitante: away.team?.displayName || 'Away',
              liga: data.leagues?.[0]?.name || deporte.sport,
              horaInicio: ev.date
            });
          }
        }
      } catch(e) {
        console.error(`Error ${deporte.path}:`, e.message);
      }
    }

    res.status(200).json({ total: allEvents.length, data: allEvents });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
