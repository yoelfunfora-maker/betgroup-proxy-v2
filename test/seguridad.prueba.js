// Prueba de la Etapa 1 (seguridad). Ejecutar: npm test
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

Object.assign(process.env,{ PORT:'3999', FIREBASE_SERVICE_ACCOUNT_B64:Buffer.from('{}').toString('base64'),
  SESSION_SECRET:'s'.repeat(40), AUDIT_SECRET:'a'.repeat(40), LEGACY_PASSWORD_PEPPER:'BetGroup-S3cr3t0-2026' });

// Datos semilla: un miembro con hash antiguo y un CEO.
const leg = (pw,salt)=>crypto.createHash('sha256').update(pw+salt+'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ana-x-com',{email:'ana@x.com',uid:'BG_ana',salt:'a1b2c3d4',hash:leg('clave123','a1b2c3d4')});
set('users/BG_ana',{email:'ana@x.com',rol:'member',rolLevel:3,creditoReal:100,hash:'h',salt:'s'});
set('credenciales_acceso/jefe-x-com',{email:'jefe@x.com',uid:'BG_jefe',salt:'00112233',hash:leg('jefe!','00112233')});
set('users/BG_jefe',{email:'jefe@x.com',rol:'CEO',rolLevel:3,creditoReal:5});
set('users/BG_ref',{nombre:'R',creadoPor:'BG_jefe',hash:'SECRETO',creditoReal:1});

require(require('path').join(__dirname, '..', 'servidor.js'));
const B='http://127.0.0.1:3999';
const call=async(m,u,b,t,extra={})=>{ const r=await fetch(B+u,{method:m,headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{}),...extra},body:b?JSON.stringify(b):undefined}); let j; try{j=await r.json();}catch{j=null;} return [r.status,j,r.headers]; };
const ok=(c,msg)=>console.log((c?'✅':'❌')+' '+msg);
setTimeout(async()=>{
  let [s,j]=await call('POST','/api/admin/reiniciar',{}); ok(s===401,'reiniciar sin sesión → '+s);
  [s]=await call('POST','/api/admin/aplicar-codigo',{codigo:'C123',uid:'x'}); ok(s===401,'aplicar-codigo sin sesión → '+s);
  [s]=await call('POST','/api/apostar',{uid:'BG_ana',amount:-50,evento:'a',tipo:'Local',cuota:2}); ok(s===401,'apostar sin sesión → '+s);
  [s]=await call('GET','/api/saldo/BG_ana'); ok(s===401,'saldo sin sesión → '+s);
  [s]=await call('POST','/api/test-reporte'); ok(s===401,'test-reporte sin sesión → '+s);
  [s,j]=await call('POST','/api/auth/login',{email:'ana@x.com',password:'mala'}); ok(s===401,'login contraseña mala → '+s);
  [s,j]=await call('POST','/api/auth/login',{email:'ana@x.com',password:'clave123'}); ok(s===200&&j.token,'login correcto (hash antiguo) → '+s);
  const tAna=j.token; ok(j.usuario.rolLevel===1,'rolLevel inflado (3) con rol member queda en '+j.usuario.rolLevel);
  ok(get('credenciales_acceso/ana-x-com/hash')===null && get('users/BG_ana/hash')===null,'hash antiguo borrado tras migrar');
  ok(get('credenciales_servidor/ana-x-com/algoritmo')==='pbkdf2-sha256','hash nuevo PBKDF2 guardado');
  [s,j]=await call('POST','/api/auth/login',{email:'ana@x.com',password:'clave123'}); ok(s===200,'segundo login con PBKDF2 → '+s);
  [s]=await call('GET','/api/saldo/BG_ana',null,tAna); ok(s===200,'ver mi saldo → '+s);
  [s]=await call('GET','/api/saldo/BG_jefe',null,tAna); ok(s===403,'ver saldo ajeno → '+s);
  [s]=await call('GET','/api/saldo/..%2Fusers',null,tAna); ok(s===400,'uid con caracteres de ruta → '+s);
  [s]=await call('POST','/api/admin/reiniciar',{},tAna); ok(s===403,'miembro intenta reiniciar → '+s);
  [s]=await call('POST','/api/apuestas/liquidar',{partidoId:'x',resultadoGanador:'Local'},tAna); ok(s===403,'miembro intenta liquidar → '+s);
  [s]=await call('POST','/api/admin/aplicar-codigo',{codigo:'C0210261200AAAAAAAAAAAA'},tAna); ok(s===400 && get('users/BG_ana/rol')==='member','código inventado rechazado → '+s);
  [s]=await call('POST','/api/apostar',{amount:-50,evento:'A vs B',tipo:'Local',cuota:2},tAna); ok(s===400,'monto negativo → '+s);
  [s]=await call('POST','/api/apostar',{amount:10,evento:'A vs B',tipo:'Local',cuota:2,uid:'BG_jefe'},tAna); ok(s===404 && get('users/BG_jefe/creditoReal')===5 && get('users/BG_ana/creditoReal')===100,'uid ajeno + evento inventado: no se toca ningún saldo → '+s);
  [s]=await call('GET','/api/usuarios/mis-referidos?subadminUid=BG_jefe',null,tAna); ok(s===403,'miembro pide referidos → '+s);
  [s,j]=await call('POST','/api/auth/login',{email:'jefe@x.com',password:'jefe!'}); const tJefe=j.token;
  [s,j]=await call('GET','/api/usuarios/mis-referidos',null,tJefe); ok(s===200 && j.length===1 && !('hash' in j[0]),'CEO ve referidos sin hash → '+s);
  [s]=await call('POST','/api/admin/reiniciar',{},tJefe); ok(s===403,'CEO reiniciar con flag apagado → '+s);
  [s,j]=await call('POST','/api/admin/generar-codigo',{rol:'admin'},tJefe); const cod=j.codigo; ok(s===200,'CEO genera código '+cod);
  [s,j]=await call('POST','/api/admin/aplicar-codigo',{codigo:cod},tAna); ok(s===200 && get('users/BG_ana/rol')==='admin','código real aplicado → '+s);
  [s]=await call('POST','/api/admin/aplicar-codigo',{codigo:cod},tAna); ok(s===400,'código reutilizado → '+s);
  [s]=await call('POST','/api/auth/logout',null,tAna); [s]=await call('GET','/api/auth/yo',null,tAna); ok(s===401,'token tras logout → '+s);
  [s,j,h]=await call('GET','/api/ruta-que-no-existe'); ok(s===404,'404 limpio');
  [s,j,h]=await call('GET','/api/ping',null,null,{origin:'https://malo.com'}); ok(!h.get('access-control-allow-origin'),'CORS rechaza web ajena');
  [s,j,h]=await call('GET','/api/ping',null,null,{origin:'https://betgroup-cuba-2024.web.app'}); ok(h.get('access-control-allow-origin')==='https://betgroup-cuba-2024.web.app','CORS acepta web propia');
  for(let i=0;i<5;i++) await call('POST','/api/auth/login',{email:'jefe@x.com',password:'no'});
  [s]=await call('POST','/api/auth/login',{email:'jefe@x.com',password:'jefe!'}); ok(s===429,'bloqueo tras fallos (o límite IP) → '+s);
  const reg=get('auditoria/registros'); ok(reg && Object.keys(reg).length>5,'auditoría registró '+Object.keys(reg||{}).length+' eventos');
  [s,j]=await call('GET','/api/admin/auditoria/verificar',null,tJefe); ok(s===200&&j.integra,'cadena de auditoría íntegra ('+j.revisados+')');
  process.exit(0);
}, 500);
