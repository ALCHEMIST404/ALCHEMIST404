'use strict';

/* StartPult CLOUD BETA. This is a test environment, not a production payment service. */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);
const DAY = 24 * 60 * 60 * 1000;
const SESSION_MS = 7 * DAY;
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const PUBLIC = path.join(__dirname, 'public');
const COOKIE_NAME = 'startpult_beta_session';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const attempts = new Map();
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS sp_users (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS sp_sessions (token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES sp_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sp_sessions_user_idx ON sp_sessions(user_id)',
  'CREATE TABLE IF NOT EXISTS sp_tournaments (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES sp_users(id) ON DELETE CASCADE, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS sp_tournaments_user_idx ON sp_tournaments(user_id, updated_at DESC)'
];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function response(res, status, data, extra = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8','Cache-Control':'no-store',...extra});
  res.end(JSON.stringify(data));
}
function str(input, max) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0,max);
}
function emailValue(value) {
  const email = str(value,254).toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,63}$/.test(email)) throw httpError(400,'Проверь адрес email');
  return email;
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw httpError(400,'Пароль должен быть длиной от 12 до 128 символов');
  }
  return value;
}
async function passwordHash(password,salt) {
  return (await scrypt(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:32*1024*1024})).toString('hex');
}
function hashSession(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(entry=>{
    const i=entry.indexOf('=');
    if(i>0) out[entry.slice(0,i).trim()]=entry.slice(i+1).trim();
  });
  return out;
}
function setCookie(res,token) {
  const value=token || '';
  const attrs=[COOKIE_NAME+'='+value,'Path=/','HttpOnly','SameSite=Lax','Secure'];
  if(token) attrs.push('Max-Age='+Math.floor(SESSION_MS/1000));
  else attrs.push('Max-Age=0');
  res.setHeader('Set-Cookie',attrs.join('; '));
}
async function newSession(res,userId) {
  const token=crypto.randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+SESSION_MS);
  await pool.query('INSERT INTO sp_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashSession(token),userId,expiresAt]);
  setCookie(res,token);
}
async function signedInUser(req) {
  const token=parseCookies(req.headers.cookie)[COOKIE_NAME];
  if(!token || token.length>256) return null;
  const result=await pool.query(
    'SELECT u.id,u.email FROM sp_sessions s JOIN sp_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [hashSession(token)]);
  return result.rows[0] || null;
}
function requireUser(user) {
  if(!user) throw httpError(401,'Сначала войди в аккаунт');
  return user;
}
function checkOrigin(req) {
  const actual=req.headers.origin;
  const host=req.headers['x-forwarded-host'] || req.headers.host;
  const expected=(IS_PRODUCTION?'https://':'http://')+host;
  if(typeof actual !== 'string' || actual !== expected) throw httpError(403,'Недопустимый источник запроса');
}
function limit(req,kind,max,period) {
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const key=kind+':'+ip.slice(0,70);
  const now=Date.now();
  let data=attempts.get(key);
  if(!data || now>data.expires) data={count:0,expires:now+period};
  data.count++;
  attempts.set(key,data);
  if(attempts.size>5000) for(const [k,v] of attempts) if(now>v.expires) attempts.delete(k);
  if(data.count>max) throw httpError(429,'Слишком много попыток. Попробуй позже');
}
async function bodyJson(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json')) throw httpError(415,'Ожидается JSON');
  let total=0,items=[];
  for await (const chunk of req) {
    total+=chunk.length;
    if(total>1024*1024) throw httpError(413,'Слишком большой запрос');
    items.push(chunk);
  }
  try {
    const parsed=JSON.parse(Buffer.concat(items).toString('utf8'));
    if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  }catch {throw httpError(400,'Некорректные данные');}
}
function normalizeTournament(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw httpError(400,'Нет данных турнира');
  const ev=input.event;
  if(!ev || typeof ev!=='object' || Array.isArray(ev)) throw httpError(400,'Нет параметров турнира');
  const title=str(ev.name,120);
  if(title.length<2) throw httpError(400,'Название турнира слишком короткое');
  const scoring=ev.scoring==='points'?'points':'time';
  const date=str(ev.date,10);
  if(date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400,'Неверная дата');
  const fee=Number(ev.fee||0);
  if(!Number.isInteger(fee)||fee<0||fee>1000000) throw httpError(400,'Неверный стартовый взнос');
  if(!Array.isArray(input.participants)||input.participants.length>2500) throw httpError(400,'Недопустимое число участников');
  const bibs=new Set();
  const participants=input.participants.map((p,i)=>{
    if(!p||typeof p!=='object'||Array.isArray(p)) throw httpError(400,'Повреждённая карточка участника');
    const bib=Number(p.bib||i+1);
    if(!Number.isInteger(bib)||bib<1||bib>999999||bibs.has(bib))throw httpError(400,'Стартовые номера должны быть уникальными');
    bibs.add(bib);
    // An incomplete participant is a valid draft. The user can fill the name later.
    const name=str(p.name,120);
    const penalty=Number(p.penalty||0);
    if(!Number.isFinite(penalty)||penalty<0||penalty>1000000)throw httpError(400,'Неверный штраф');
    return {
      id:str(p.id,80)||crypto.randomUUID(),bib,name,team:str(p.team,120),
      category:str(p.category,80)||'Общий зачёт',result:str(p.result,50),
      penalty,paid:p.paid===true,
      status:['OK','DNS','DNF','DSQ'].includes(p.status)?p.status:'OK'
    };
  });
  return {version:1,event:{name:title,date,place:str(ev.place,120),
    sport:str(ev.sport,120),scoring,fee},participants};
}
function blankTournament() {
  return {version:1,event:{name:'Новый турнир',date:new Date().toISOString().slice(0,10),
    place:'',sport:'Любительские соревнования',scoring:'time',fee:0},participants:[]};
}
function idFromPath(p) {
  const match=p.match(/^\/api\/tournaments\/([a-f0-9-]{36})$/);
  return match?match[1]:null;
}
async function api(req,res,url) {
  if(req.method!=='GET'&&req.method!=='HEAD')checkOrigin(req);
  if(url.pathname==='/api/health'&&req.method==='GET'){
    await pool.query('SELECT 1');return response(res,200,{ok:true,mode:'beta'});
  }
  if(url.pathname==='/api/auth/register'&&req.method==='POST'){
    limit(req,'register',5,60*60*1000);
    const data=await bodyJson(req);
    const email=emailValue(data.email),password=validatePassword(data.password);
    const salt=crypto.randomBytes(16).toString('hex');
    const digest=await passwordHash(password,salt);
    const id=crypto.randomUUID();
    try {
      await pool.query('INSERT INTO sp_users(id,email,password_salt,password_hash) VALUES($1,$2,$3,$4)',
        [id,email,salt,digest]);
    }catch(error){
      if(error.code==='23505')throw httpError(409,'Такой email уже зарегистрирован');
      throw error;
    }
    await newSession(res,id);
    return response(res,201,{user:{id,email},beta:true});
  }
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
    limit(req,'login',12,15*60*1000);
    const data=await bodyJson(req);
    const email=emailValue(data.email),password=validatePassword(data.password);
    const found=await pool.query('SELECT id,email,password_salt,password_hash FROM sp_users WHERE email=$1',[email]);
    const user=found.rows[0];
    const digest=await passwordHash(password,user?user.password_salt:'a'.repeat(32));
    const matches=user && crypto.timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(user.password_hash,'hex'));
    if(!matches)throw httpError(401,'Неверный email или пароль');
    await newSession(res,user.id);
    return response(res,200,{user:{id:user.id,email:user.email},beta:true});
  }
  const user=await signedInUser(req);
  if(url.pathname==='/api/auth/me'&&req.method==='GET')return response(res,200,{user:user?{id:user.id,email:user.email}:null,beta:true});
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
    const token=parseCookies(req.headers.cookie)[COOKIE_NAME];
    if(token)await pool.query('DELETE FROM sp_sessions WHERE token_hash=$1',[hashSession(token)]);
    setCookie(res,'');
    return response(res,200,{ok:true});
  }
  requireUser(user);
  if(url.pathname==='/api/tournaments'&&req.method==='GET'){
    const found=await pool.query('SELECT id,data,updated_at FROM sp_tournaments WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100',[user.id]);
    const list=found.rows.map(r=>({id:r.id,name:r.data.event.name,
      date:r.data.event.date,participants:r.data.participants.length,updatedAt:r.updated_at}));
    return response(res,200,{tournaments:list});
  }
  if(url.pathname==='/api/tournaments'&&req.method==='POST'){
    limit(req,'create',30,60*60*1000);
    const count=await pool.query('SELECT count(*)::integer AS total FROM sp_tournaments WHERE user_id=$1',[user.id]);
    if(count.rows[0].total>=100)throw httpError(409,'Максимум 100 турниров на один тестовый аккаунт');
    const body=await bodyJson(req);
    const data=normalizeTournament(body.data||blankTournament());
    const id=crypto.randomUUID();
    const found=await pool.query('INSERT INTO sp_tournaments(id,user_id,data) VALUES($1,$2,$3::jsonb) RETURNING updated_at',
      [id,user.id,JSON.stringify(data)]);
    return response(res,201,{id,data,updatedAt:found.rows[0].updated_at});
  }
  const tid=idFromPath(url.pathname);
  if(tid&&req.method==='GET'){
    const found=await pool.query('SELECT data,updated_at FROM sp_tournaments WHERE id=$1 AND user_id=$2',[tid,user.id]);
    if(!found.rows.length)throw httpError(404,'Турнир не найден');
    return response(res,200,{id:tid,data:found.rows[0].data,updatedAt:found.rows[0].updated_at});
  }
  if(tid&&req.method==='PUT'){
    const incoming=await bodyJson(req);
    const data=normalizeTournament(incoming.data);
    const found=await pool.query('UPDATE sp_tournaments SET data=$1::jsonb,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING updated_at',
      [JSON.stringify(data),tid,user.id]);
    if(!found.rows.length)throw httpError(404,'Турнир не найден');
    return response(res,200,{id:tid,data,updatedAt:found.rows[0].updated_at});
  }
  if(tid&&req.method==='DELETE'){
    const found=await pool.query('DELETE FROM sp_tournaments WHERE id=$1 AND user_id=$2 RETURNING id',[tid,user.id]);
    if(!found.rows.length)throw httpError(404,'Турнир не найден');
    return response(res,200,{ok:true});
  }
  throw httpError(404,'Неизвестная команда');
}
const staticFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const media={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'};
async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(req.method!=='GET')throw httpError(405,'Метод недоступен');
    const file=staticFiles[url.pathname];
    if(!file)throw httpError(404,'Страница не найдена');
    const data=await fs.readFile(path.join(PUBLIC,file));
    res.writeHead(200,{'Content-Type':media[file],'Cache-Control':'no-store'});
    res.end(data);
  }catch(error){
    if(!error.status)console.error('Server failure:',error.code||error.name||'UNKNOWN');
    if(!res.headersSent)response(res,error.status||500,{error:error.status?error.message:'Ошибка сервера'});
    else res.end();
  }
}
async function start(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL environment variable is required');
  for(const query of SCHEMA)await pool.query(query);
  await pool.query('DELETE FROM sp_sessions WHERE expires_at<now()');
  const server=http.createServer(handler);
  server.listen(PORT,'0.0.0.0',()=>console.log('StartPult cloud beta ready on port '+PORT));
}
if(require.main===module)start().catch(err=>{console.error('Unable to start:',err.code||err.message);process.exitCode=1;pool.end().catch(()=>{});});
module.exports={normalizeTournament,emailValue,validatePassword,passwordHash,hashSession,parseCookies,blankTournament,handler,start};
