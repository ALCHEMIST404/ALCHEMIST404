'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');

test('HTTP integration: separate users, saved events, backup, restore, delete account', async t => {
  const users = new Map();
  const sessions = new Map();
  const tournaments = new Map();
  const now = () => new Date().toISOString();
  const query = async (statement, params=[]) => {
    const sql=statement.trim().replace(/\s+/g,' ');
    const rows = x => ({rows:x, rowCount:x.length});
    if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return rows([]);
    if (sql.startsWith('INSERT INTO sp_users')) {
      const [id,email,salt,digest] = params;
      if (users.has(email)) {const error=Error('duplicate'); error.code='23505'; throw error;}
      users.set(email,{id,email,password_salt:salt,password_hash:digest});
      return rows([]);
    }
    if (sql.startsWith('INSERT INTO sp_sessions')) {
      const [token_hash,user_id,expiresAt] = params;
      sessions.set(token_hash,{user_id,expiresAt});
      return rows([]);
    }
    if (sql.startsWith('SELECT id,email,password_salt,password_hash FROM sp_users WHERE email=')) {
      const user=users.get(params[0]);return rows(user?[user]:[]);
    }
    if (sql.startsWith('SELECT u.id,u.email FROM sp_sessions')) {
      const session=sessions.get(params[0]);
      if (!session || new Date(session.expiresAt).getTime()<=Date.now()) return rows([]);
      const user=[...users.values()].find(x=>x.id===session.user_id);
      return rows(user?[{id:user.id,email:user.email}]:[]);
    }
    if (sql.startsWith('SELECT count(*)::integer AS total FROM sp_tournaments')) {
      return rows([{total:[...tournaments.values()].filter(x=>x.user_id===params[0]).length}]);
    }
    if (sql.startsWith('INSERT INTO sp_tournaments')) {
      const [id,user_id,data] = params;
      tournaments.set(id,{id,user_id,data:JSON.parse(data),created_at:now(),updated_at:now()});
      return rows(sql.includes('RETURNING updated_at')?[{updated_at:tournaments.get(id).updated_at}]:[]);
    }
    if (sql.startsWith('SELECT id,data,updated_at FROM sp_tournaments WHERE user_id=')) {
      return rows([...tournaments.values()].filter(x=>x.user_id===params[0]).map(x=>({
        id:x.id,data:x.data,updated_at:x.updated_at
      })));
    }
    if (sql.startsWith('SELECT data,created_at,updated_at FROM sp_tournaments WHERE user_id=')) {
      return rows([...tournaments.values()].filter(x=>x.user_id===params[0]).map(x=>({
        data:x.data,created_at:x.created_at,updated_at:x.updated_at
      })));
    }
    if (sql.startsWith('SELECT data,updated_at FROM sp_tournaments WHERE id=')) {
      const event=tournaments.get(params[0]);
      return rows(event && event.user_id===params[1]?[{data:event.data,updated_at:event.updated_at}]:[]);
    }
    if (sql.startsWith('UPDATE sp_tournaments SET')) {
      const event=tournaments.get(params[1]);
      if(!event || event.user_id!==params[2])return rows([]);
      event.data=JSON.parse(params[0]);event.updated_at=now();
      return rows([{updated_at:event.updated_at}]);
    }
    if (sql.startsWith('SELECT id FROM sp_users WHERE id=')) {
      const user=[...users.values()].find(x=>x.id===params[0]);
      return rows(user?[{id:user.id}]:[]);
    }
    if (sql.startsWith('SELECT password_salt,password_hash FROM sp_users WHERE id=')) {
      const user=[...users.values()].find(x=>x.id===params[0]);
      return rows(user?[{password_salt:user.password_salt,password_hash:user.password_hash}]:[]);
    }
    if (sql.startsWith('DELETE FROM sp_sessions')) {
      sessions.delete(params[0]);return rows([]);
    }
    if (sql.startsWith('DELETE FROM sp_tournaments WHERE id=')) {
      const event=tournaments.get(params[0]);
      if(!event || event.user_id!==params[1])return rows([]);
      tournaments.delete(params[0]);return rows([{id:params[0]}]);
    }
    if (sql.startsWith('DELETE FROM sp_users WHERE id=')) {
      const user=[...users.values()].find(x=>x.id===params[0]);
      if(user){
        users.delete(user.email);
        for(const [id,event] of tournaments)if(event.user_id===user.id)tournaments.delete(id);
        for(const [token,session] of sessions)if(session.user_id===user.id)sessions.delete(token);
      }
      return rows([]);
    }
    throw Error('Unsupported SQL in test: '+sql.slice(0,110));
  };

  const originalQuery=Pool.prototype.query;
  const originalConnect=Pool.prototype.connect;
  Pool.prototype.query=function(...args){return query(...args);};
  Pool.prototype.connect=async function(){return {query,release(){}};};

  const { handler }=require('../server');
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    Pool.prototype.query=originalQuery;
    Pool.prototype.connect=originalConnect;
  });
  const address='http://127.0.0.1:'+server.address().port;
  const origin=(process.env.NODE_ENV==='production'||process.env.RENDER?'https://':'http://')+
    '127.0.0.1:'+server.address().port;
  const request=async (url,method='GET',body,cookie='')=>{
    const response=await fetch(address+url,{
      method,
      headers:{...(body===undefined?{}:{'content-type':'application/json'}),
        ...(method==='GET'?{}:{Origin:origin}),
        ...(cookie?{Cookie:cookie}:{})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const payload=await response.json();
    return {status:response.status,payload,cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
  };
  const register=async(email,password)=>{
    const response=await request('/api/auth/register','POST',{email,password});
    assert.equal(response.status,201);
    assert.match(response.cookie,/^startpult_beta_session=/);
    return response;
  };
  const alice=await register('alice@example.test','Alice-secret-long-123');
  assert.equal((await request('/api/auth/me','GET',undefined,alice.cookie)).payload.user.email,'alice@example.test');
  const created=await request('/api/tournaments','POST',{},alice.cookie);
  assert.equal(created.status,201);
  const aliceId=created.payload.id;
  const event=created.payload.data;
  event.event.name='Тестовый марафон';
  event.participants=[{bib:1,name:'Тестовый участник',category:'Общий зачёт',result:'05:12.00'}];
  const updated=await request('/api/tournaments/'+aliceId,'PUT',{data:event},alice.cookie);
  assert.equal(updated.status,200);
  const loaded=await request('/api/tournaments/'+aliceId,'GET',undefined,alice.cookie);
  assert.equal(loaded.payload.data.event.name,'Тестовый марафон');
  assert.equal(loaded.payload.data.participants.length,1);
  const backedUp=await request('/api/account/export','GET',undefined,alice.cookie);
  assert.equal(backedUp.status,200);
  assert.equal(backedUp.payload.tournaments.length,1);
  assert.equal(backedUp.payload.tournaments[0].data.event.name,'Тестовый марафон');

  const bob=await register('bob@example.test','Bob-secret-long-1234');
  assert.equal((await request('/api/tournaments/'+aliceId,'GET',undefined,bob.cookie)).status,404);
  assert.equal((await request('/api/tournaments/'+aliceId,'PUT',{data:event},bob.cookie)).status,404);
  assert.equal((await request('/api/tournaments/'+aliceId,'DELETE',{},bob.cookie)).status,404);
  assert.equal((await request('/api/account/export','GET',undefined,bob.cookie)).payload.tournaments.length,0);

  const imported=await request('/api/account/import','POST',backedUp.payload,bob.cookie);
  assert.equal(imported.status,201);
  assert.equal(imported.payload.imported,1);
  const bobEvents=await request('/api/tournaments','GET',undefined,bob.cookie);
  assert.equal(bobEvents.payload.tournaments.length,1);
  assert.notEqual(bobEvents.payload.tournaments[0].id,aliceId);

  const unauthorized=await request('/api/tournaments');
  assert.equal(unauthorized.status,401);
  const noOrigin=await fetch(address+'/api/tournaments',{method:'POST',headers:{Cookie:bob.cookie,'content-type':'application/json'},body:'{}'});
  assert.equal(noOrigin.status,403);

  const deleted=await request('/api/account/delete','POST',{password:'Alice-secret-long-123',confirm:'УДАЛИТЬ'},alice.cookie);
  assert.equal(deleted.status,200);
  assert.equal(deleted.payload.deleted,true);
  assert.equal((await request('/api/auth/me','GET',undefined,alice.cookie)).payload.user,null);
  assert.equal((await request('/api/tournaments','GET',undefined,bob.cookie)).payload.tournaments.length,1);
});
