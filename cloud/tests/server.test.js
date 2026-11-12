'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  normalizeTournament,
  emailValue,
  validatePassword,
  passwordHash,
  hashSession,
  parseCookies,
  blankTournament
} = require('../server');

test('new events are empty; no personal examples', () => {
  const state = blankTournament();
  assert.equal(state.participants.length,0);
  assert.equal(state.event.scoring,'time');
});
test('email normalized with validation', () => {
  assert.equal(emailValue('  TEST@EXAMPLE.COM '),'test@example.com');
  assert.throws(()=>emailValue('not-an-email'),/email/);
});
test('password requires at least 12 chars', () => {
  assert.throws(()=>validatePassword('weak-password'.slice(0,10)));
  assert.equal(validatePassword('sufficient-password'),'sufficient-password');
});
test('scrypt hashes are deterministic per salt and not plain text', async () => {
  const salt=crypto.randomBytes(16).toString('hex');
  const a=await passwordHash('Test-password-long-123',salt);
  const b=await passwordHash('Test-password-long-123',salt);
  const c=await passwordHash('Different-password-123',salt);
  assert.equal(a,b);
  assert.notEqual(a,c);
  assert.equal(a.length,128);
  assert.notEqual(a,'Test-password-long-123');
});
test('session identifier stored as SHA-256 digest', () => {
  const raw=crypto.randomBytes(32).toString('base64url');
  assert.notEqual(hashSession(raw),raw);
  assert.equal(hashSession(raw).length,64);
  assert.equal(hashSession(raw),hashSession(raw));
});
test('only exact cookie name is read', () => {
  assert.equal(parseCookies('startpult_beta_session=abc; other=value').startpult_beta_session,'abc');
});
test('validate empty tournament', () => {
  const out=normalizeTournament(blankTournament());
  assert.equal(out.participants.length,0);
  assert.equal(out.event.name,'Новый турнир');
});
test('incomplete participants are allowed as drafts', () => {
  const input=blankTournament();
  input.participants=[{id:'test-participant',bib:1,name:'',category:'Общий зачёт'}];
  const saved=normalizeTournament(input);
  assert.equal(saved.participants[0].name,'');
  assert.equal(saved.participants[0].bib,1);
});
test('reject duplicate bibs', () => {
  const input=blankTournament();
  input.participants=[{bib:1,name:'A'},{bib:1,name:'B'}];
  assert.throws(()=>normalizeTournament(input),/уникальными/);
});
test('reject over-sized tournament', () => {
  const input=blankTournament();
  input.participants=Array.from({length:2501},(_,i)=>({bib:i+1,name:'Тестовый участник'}));
  assert.throws(()=>normalizeTournament(input),/число участников/);
});
test('participants are normalized and unrecognized status defaults OK', () => {
  const input=blankTournament();
  input.participants=[{bib:1,name:' Тестовый участник ',status:'INVALID',result:'5:30.20',paid:true,penalty:1.2}];
  const out=normalizeTournament(input);
  assert.equal(out.participants[0].name,'Тестовый участник');
  assert.equal(out.participants[0].status,'OK');
  assert.equal(out.participants[0].result,'5:30.20');
  assert.equal(out.participants[0].paid,true);
});
test('reject malformed date and negative fees', () => {
  const input=blankTournament();input.event.date='next Thursday';
  assert.throws(()=>normalizeTournament(input),/дата/);
  input.event.date='2026-11-13';input.event.fee=-1;
  assert.throws(()=>normalizeTournament(input),/взнос/);
});
