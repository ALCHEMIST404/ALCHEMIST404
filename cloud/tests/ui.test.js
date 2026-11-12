'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../public/index.html'),'utf8');
const css=fs.readFileSync(path.resolve(__dirname,'../public/style.css'),'utf8');
const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
test('all DOM IDs referenced in JavaScript exist in HTML',()=>{
  const expected=[...new Set([...app.matchAll(/\$\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)].map(match=>match[1]))];
  const missing=expected.filter(name=>!ids.includes(name));
  assert.deepEqual(missing,[]);
});
test('DOM IDs are unique',()=>{
  assert.equal(new Set(ids).size,ids.length);
});
test('login form and organizer actions remain available',()=>{
  for(const id of ['authForm','authSwitch','authSubmit','workspace','eventList','newTournament','editor','save','reloadServer','addParticipant','resultList','exportAll','importAll','deleteAccountDialog','changePasswordForm']){
    assert.ok(ids.includes(id),'Missing '+id);
  }
});
test('visual design includes responsive breakpoints and accessible focus states',()=>{
  assert.match(css,/@media\s*\(max-width:\s*730px\)/);
  assert.match(css,/@media\s*\(max-width:\s*430px\)/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/@media\s*\(prefers-reduced-motion:reduce\)/);
});
test('public homepage has labelled, non-identifying preview and no leaked sample names',()=>{
  assert.match(html,/Схематичная иллюстрация, не реальные результаты/);
  for(const banned of ['Стелла Альдеркапт','Генрих Данко','Леонард Вайс','Маттео Райнхардт','Нисхождение','Гиены']){
    assert.ok(!html.includes(banned),'Private sample name leaked');
    assert.ok(!app.includes(banned),'Private sample name leaked');
  }
});
test('CSS braces are balanced',()=>{
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
});
test('auth showcase and form each have a closing container',()=>{
  assert.match(html,/class="auth-layout" id="auth"/);
  assert.match(html,/class="auth-showcase"/);
  assert.match(html,/class="auth-card panel"/);
  assert.match(html,/id="authForm"/);
});
