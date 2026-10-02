// Prueba de la Etapa 2 (dinero). Ejecutar: npm test
// Prueba de humo: arranca servidor.js con una RTDB falsa en memoria.
const Module = require('module');
const crypto = require('crypto');
const root = {};
const partes = p => p.split('/').filter(Boolean);
function get(p){ let n=root; for(const k of partes(p)){ if(n==null||typeof n!=='object') return null; n=n[k]; } return n===undefined?null:JSON.parse(JSON.stringify(n)); }
function set(p,v){ const ks=partes(p); if(!ks.length){ Object.keys(root).forEach(k=>delete root[k]); Object.assign(root,v||{}); return; } let n=root; for(const k of ks.slice(0,-1)){ if(typeof n[k]!=='object'||n[k]===null) n[k]={}; n=n[k]; } if(v===null||v===undefined) delete n[ks.at(-1)]; else n[ks.at(-1)]=JSON.parse(JSON.stringify(v)); }
function snap(v){ return { val:()=>v, exists:()=>v!=null, forEach(cb){ if(v&&typeof v==='object') Object.keys(v).sort((a,b)=>(+a)-(+b)||a.localeCompare(b)).forEach(k=>cb({key:k,val:()=>v[k]})); } }; }
function ref(p=''){ let filtro=null; const r={
  once:async()=>{ let v=get(p); if(filtro&&v){ const o={}; for(const [k,x] of Object.entries(v)) if(x&&x[filtro.c]===filtro.v) o[k]=x; v=Object.keys(o).length?o:null; } return snap(v); },
  set:async v=>set(p,v), update:async o=>{ for(const [k,v] of Object.entries(o)) set(p+'/'+k,v); },
  transaction:async fn=>{ /* Como Firebase: primera llamada con null (sin caché), reintento con el valor real si no coincide */
    const real=get(p); let r2=fn(null); if(r2===undefined) return {committed:false,snapshot:snap(null)};
    if(real!==null && JSON.stringify(r2)!==JSON.stringify(real)){ r2=fn(get(p)); if(r2===undefined) return {committed:false,snapshot:snap(real)}; }
    set(p,r2===null?null:r2); return {committed:true,snapshot:snap(get(p))}; },
  orderByChild(c){ filtro={c}; return r; }, equalTo(v){ filtro.v=v; return r; }, orderByKey(){return r;}, limitToLast(){return r;},
  push(){ return ref(p+'/'+Date.now()+Math.random().toString(36).slice(2)); }, remove:async()=>set(p,null)
}; return r; }
const appFalso = { initializeApp(){}, cert:()=>({}) }; const dbFalso = { getDatabase:()=>({ ref }) };
const orig = Module._load;
Module._load = function(req,...a){ if(req==='firebase-admin/app') return appFalso; if(req==='firebase-admin/database') return dbFalso; return orig.call(this,req,...a); };

const fetch2=global.fetch;
Object.assign(process.env,{ PORT:'3999', FIREBASE_SERVICE_ACCOUNT_B64:Buffer.from('{}').toString('base64'),
  SESSION_SECRET:'s'.repeat(40), AUDIT_SECRET:'a'.repeat(40), LEGACY_PASSWORD_PEPPER:'BetGroup-S3cr3t0-2026', ODDS_API_KEYS:'k1' });

// Datos semilla: un miembro con hash antiguo y un CEO.
const leg = (pw,salt)=>crypto.createHash('sha256').update(pw+salt+'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ana-x-com',{email:'ana@x.com',uid:'BG_ana',salt:'a1b2c3d4',hash:leg('clave123','a1b2c3d4')});
set('users/BG_ana',{email:'ana@x.com',rol:'member',rolLevel:3,creditoReal:100,hash:'h',salt:'s'});
set('credenciales_acceso/jefe-x-com',{email:'jefe@x.com',uid:'BG_jefe',salt:'00112233',hash:leg('jefe!','00112233')});
set('users/BG_jefe',{email:'jefe@x.com',rol:'CEO',rolLevel:3,creditoReal:5});
set('users/BG_ref',{nombre:'R',creadoPor:'BG_jefe',hash:'SECRETO',creditoReal:1});


const EventEmitter=require('events');
const httpsReal=require('https');
const futuro=new Date(Date.now()+86400000).toISOString();
const ESPN={events:[{id:'777',date:futuro,status:{type:{state:'pre'}},competitions:[{status:{type:{state:'pre'}},competitors:[
  {homeAway:'home',team:{displayName:'Equipo A'},score:'0'},{homeAway:'away',team:{displayName:'Equipo B'},score:'0'}]}]}],leagues:[{name:'Liga Prueba'}]};
const httpsFalso={...httpsReal, get:()=>{const e=new EventEmitter();return e;}, request:(opt,cb)=>{
  const req=new EventEmitter(); req.setTimeout=()=>{}; req.destroy=()=>{};
  req.end=()=>{ const res=new EventEmitter(); cb(res); const body=opt.path.includes('soccer/eng.1')?JSON.stringify(ESPN):'{"events":[]}'; setImmediate(()=>{res.emit('data',body);res.emit('end');}); };
  return req; }};
const prevLoad=Module._load;
Module._load=function(req,...a){ if(req==='https') return httpsFalso; return prevLoad.call(this,req,...a); };
global.fetch=async()=>{ throw new Error('sin red en pruebas'); };
const axiosReal=require('axios');
const axiosFalso=Object.assign(Object.create(axiosReal),{ get:async(url)=>{ if(url.includes('the-odds-api')) return {data:[{home_team:'Equipo A',away_team:'Equipo B',bookmakers:[{markets:[{key:'h2h',outcomes:[{name:'Equipo A',price:1.8},{name:'Equipo B',price:2.1},{name:'Draw',price:3.2}]}]}]}]}; throw new Error('sin red'); }, post:async()=>{ throw new Error('sin red'); } });
const prevLoad2=Module._load;
Module._load=function(req,...a){ if(req==='axios') return axiosFalso; return prevLoad2.call(this,req,...a); };

require(require('path').join(__dirname, '..', 'servidor.js'));
const B='http://127.0.0.1:3999';
const call=async(m,u,b,t)=>{ const r=await fetch2(B+u,{method:m,headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined}); let j; try{j=await r.json();}catch{j=null;} return [r.status,j]; };
const ok=(c,msg)=>console.log((c?'✅':'❌')+' '+msg);
setTimeout(async()=>{
  set('config',{minBet:100,maxBet:500,maxPago:2500,dailyLossLimit:600});
  set('users/BG_ana/creditoReal',150); set('users/BG_ana/creditoPromo',300);
  let [s,j]=await call('POST','/api/auth/login',{email:'ana@x.com',password:'clave123'}); const t=j.token;
  [s,j]=await call('POST','/api/auth/login',{email:'jefe@x.com',password:'jefe!'}); const tJefe=j.token;
  [s,j]=await call('GET','/api/fixtures'); const ev=j.data&&j.data.find(e=>e.id==='777'); ok(ev&&ev.cuota_local>1,'evento de prueba cargado, cuota local '+(ev&&ev.cuota_local));
  const q=ev.cuota_local;
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:100,cuota:q*10},t); ok(s===409&&j.cuotaActual===q,'cuota falsa del cliente (×10) rechazada → '+s);
  [s,j]=await call('POST','/api/apostar',{eventoId:'999',tipo:'Local',amount:100},t); ok(s===404,'evento inexistente → '+s);
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:50},t); ok(s===400,'por debajo del mínimo → '+s);
  const dos=await Promise.all([1,2].map(()=>call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:100,cuota:q},t)));
  const exitos=dos.filter(([s])=>s===200).length; ok(exitos===1 && get('users/BG_ana/creditoReal')===50,'2 apuestas simultáneas con saldo para 1: pasan '+exitos+', saldo '+get('users/BG_ana/creditoReal'));
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Visitante',amount:200,tipoSaldo:'promo'},t); ok(s===200 && get('users/BG_ana/creditoPromo')===100,'apuesta promo descuenta de creditoPromo → '+s);
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:100,tipoSaldo:'promo'},t); ok(s===200,'tercera apuesta dentro del límite diario (100+200+100=400 de 600) → '+s);
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:100,tipoSaldo:'promo'},t); ok(s===400,'saldo promo insuficiente → '+s+' '+(j&&j.error));
  set('users/BG_ana/creditoPromo',1000);
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:300,tipoSaldo:'promo'},t); ok(s===403,'supera límite diario (400+300>600) → '+s+' '+(j&&j.error));
  set('users/BG_ana/autoexcludedUntil',Date.now()+86400000);
  [s,j]=await call('POST','/api/apostar',{eventoId:'777',tipo:'Local',amount:100},t); ok(s===403,'autoexcluida no puede apostar → '+s);
  set('users/BG_ana/autoexcludedUntil',null);
  [s]=await call('POST','/api/apuestas/liquidar',{partidoId:'777',resultadoGanador:'Local'},t); ok(s===403,'miembro no liquida → '+s);
  const real0=get('users/BG_ana/creditoReal'), promo0=get('users/BG_ana/creditoPromo');
  const tres=await Promise.all([1,2,3].map(()=>call('POST','/api/apuestas/liquidar',{partidoId:'777',resultadoGanador:'Local'},tJefe)));
  const total=tres.reduce((a,[s,j])=>a+(j.liquidadas||0),0);
  const ganLocal=Math.round(100*q*100)/100;
  ok(total===Object.keys(get('apuestas/BG_ana')).length,'3 liquidaciones simultáneas: cada apuesta se liquida 1 vez ('+total+')');
  // Regla de la Etapa 8: la apuesta promo ganada (100) paga SOLO su ganancia, y al saldo real.
  const gananciaPromo=Math.round(100*(q-1)*100)/100;
  ok(get('users/BG_ana/creditoReal')===Math.round((real0+ganLocal+gananciaPromo)*100)/100,'premio real pagado una sola vez + ganancia de la promo al real: '+real0+' → '+get('users/BG_ana/creditoReal'));
  ok(get('users/BG_ana/creditoPromo')===promo0,'promo: la ganada no devuelve nada al promo (se consume) y la perdida tampoco: '+promo0+' → '+get('users/BG_ana/creditoPromo'));
  const aps=Object.values(get('apuestas/BG_ana'));
  ok(aps.every(a=>a.estado!=='pendiente' && a.pagado===true),'todas liquidadas y marcadas como pagadas');
  [s,j]=await call('POST','/api/apuestas/liquidar',{partidoId:'777',resultadoGanador:'Visitante'},tJefe); ok(j.liquidadas===0,'re-liquidar con otro resultado no cambia nada');
  [s,j]=await call('GET','/api/admin/auditoria/verificar',null,tJefe); ok(j.integra,'auditoría íntegra ('+j.revisados+' registros)');
  process.exit(0);
}, 1500);
