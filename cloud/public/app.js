'use strict';

(function () {
  const $=id=>document.getElementById(id);
  const state={user:null,list:[],id:null,data:null,register:false,dirty:false,saving:false,timer:null};
  function node(tag,cls,text){
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=String(text);
    return el;
  }
  async function api(path,method='GET',data){
    let res;
    try{
      res=await fetch(path,{method,credentials:'same-origin',
        headers:data===undefined?{}:{'Content-Type':'application/json'},
        body:data===undefined?undefined:JSON.stringify(data)});
    }catch{throw Error('Нет соединения с сервером. Проверь интернет.');}
    let json;
    try{json=await res.json();}catch{throw Error('Сервер вернул неожиданный ответ');}
    if(!res.ok)throw Error(json.error||'Ошибка сервера '+res.status);
    return json;
  }
  let toastTimeout;
  function toast(message){
    const box=$('toast');
    box.textContent=message;
    box.hidden=false;
    clearTimeout(toastTimeout);
    toastTimeout=setTimeout(()=>{box.hidden=true;},4500);
  }
  function setAuth(){
    $('auth').hidden=Boolean(state.user);
    $('workspace').hidden=!state.user;
    $('logout').hidden=!state.user;
    $('userEmail').textContent=state.user?state.user.email:'';
  }
  function setMode(){
    $('authTitle').textContent=state.register?'Создать тестовый аккаунт':'Вход в СтартПульт';
    $('authSubmit').textContent=state.register?'Зарегистрироваться':'Войти';
    $('authSwitch').textContent=state.register?'Уже есть аккаунт? Войти':'Нет аккаунта? Зарегистрироваться';
    $('authForm').elements.password.autocomplete=state.register?'new-password':'current-password';
  }
  async function loadList(){
    const data=await api('/api/tournaments');
    state.list=data.tournaments;
    const box=$('eventList');
    box.replaceChildren();
    if(!state.list.length){
      const empty=node('div','empty');
      empty.append(node('strong','', 'Пока нет турниров'));
      empty.append(node('p','', 'Нажми «Новый турнир», чтобы начать.'));
      box.append(empty);
      return;
    }
    for(const item of state.list){
      const card=node('button','event-card');
      card.type='button';
      card.append(node('strong','',item.name));
      card.append(node('span','date',item.date||'Дата не указана'));
      card.append(node('span','count',item.participants+' участников · Открыть'));
      card.addEventListener('click',()=>openTournament(item.id).catch(e=>toast(e.message)));
      box.append(card);
    }
  }
  async function afterLogin(user){
    state.user=user;
    setAuth();
    $('listing').hidden=false;
    $('editor').hidden=true;
    await loadList();
  }
  async function loadMe(){
    try{
      const found=await api('/api/auth/me');
      if(found.user)await afterLogin(found.user);
      else {state.user=null;setAuth();}
    }catch(e){toast(e.message);setAuth();}
  }
  function saveStatus(msg,good=true){
    $('saveState').textContent=msg;
    $('saveState').style.color=good?'#8fe6d1':'#f0a5af';
  }
  function markDirty(renderResults=false){
    state.dirty=true;
    saveStatus('Не сохранено',false);
    if(renderResults)drawResults();
    clearTimeout(state.timer);
    state.timer=setTimeout(()=>save().catch(e=>toast(e.message)),1200);
  }
  function fieldsToState(){
    const event=state.data.event;
    event.name=$('eventName').value;
    event.date=$('eventDate').value;
    event.sport=$('eventSport').value;
    event.place=$('eventPlace').value;
    event.scoring=$('eventScoring').value;
    event.fee=Number($('eventFee').value||0);
  }
  async function save(){
    clearTimeout(state.timer);
    if(!state.id||!state.dirty||state.saving)return true;
    fieldsToState();
    if(state.data.event.name.trim().length<2){saveStatus('Укажи название турнира',false);return false;}
    state.saving=true;
    $('save').disabled=true;
    saveStatus('Сохраняю...');
    const payload=JSON.stringify(state.data);
    try{
      const response=await api('/api/tournaments/'+state.id,'PUT',{data:state.data});
      if(payload===JSON.stringify(state.data)) {
        state.dirty=false;
        saveStatus('Сохранено в облаке');
      } else {
        saveStatus('Есть новые изменения',false);
        state.timer=setTimeout(()=>save().catch(e=>toast(e.message)),1000);
      }
      return Boolean(response.id);
    }catch(e){
      saveStatus('Ошибка сохранения',false);
      toast(e.message);
      return false;
    }finally{
      state.saving=false;
      $('save').disabled=false;
    }
  }
  async function leaveEditor(){
    if(state.dirty){
      const ok=await save();
      if(!ok||state.dirty){toast('Не удалось сохранить изменения. Останься в турнире и скачай копию.');return;}
    }
    state.id=null;state.data=null;
    $('editor').hidden=true;$('listing').hidden=false;
    await loadList();
  }
  async function openTournament(id){
    if(state.dirty){
      const ok=await save();
      if(!ok||state.dirty)return;
    }
    const opened=await api('/api/tournaments/'+id);
    state.id=id;state.data=opened.data;state.dirty=false;
    $('listing').hidden=true;$('editor').hidden=false;
    const ev=opened.data.event;
    $('eventName').value=ev.name||'';
    $('eventDate').value=ev.date||'';
    $('eventSport').value=ev.sport||'';
    $('eventPlace').value=ev.place||'';
    $('eventScoring').value=ev.scoring||'time';
    $('eventFee').value=String(ev.fee||0);
    drawParticipants();drawResults();saveStatus('Сохранено в облаке');
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function addField(labelText,key,value,type='text'){
    const label=node('label','',labelText);
    const input=node('input');
    input.type=type;input.value=value===undefined?'':String(value);
    if(key==='name')input.maxLength=120;
    if(key==='category'||key==='team')input.maxLength=120;
    if(key==='bib'){input.min='1';input.max='999999';}
    if(key==='penalty'){input.min='0';input.max='1000000';input.step='0.01';}
    label.append(input);
    return {label,input};
  }
  function drawParticipants(){
    const list=$('participantList');list.replaceChildren();
    if(!state.data.participants.length){
      list.append(node('p','small muted','Здесь пока никого нет. Добавь первого тестового участника.'));
      return;
    }
    for(const p of state.data.participants){
      const card=node('div','participant-item');
      const fields=node('div','participant-fields');
      for(const [key,title,type,cls] of [
        ['bib','№','number','numberfield'],
        ['name','Имя','text','namefield'],
        ['team','Команда','text','teamfield'],
        ['category','Категория','text','categoryfield']]){
        const {label,input}=addField(title,key,p[key],type);
        label.className=cls;
        input.addEventListener('input',()=>{
          p[key]=key==='bib'?Number(input.value):input.value;
          markDirty(true);
        });
        fields.append(label);
      }
      card.append(fields);
      const bottom=node('div','participant-bottom');
      const paid=node('label');
      const paidInput=node('input');
      paidInput.type='checkbox';paidInput.checked=Boolean(p.paid);
      paidInput.addEventListener('change',()=>{p.paid=paidInput.checked;markDirty();});
      paid.append(paidInput,node('span','', 'Взнос подтверждён'));
      bottom.append(paid);
      const remove=node('button','delete-inline','Удалить');
      remove.type='button';
      remove.addEventListener('click',()=>{
        state.data.participants=state.data.participants.filter(x=>x.id!==p.id);
        drawParticipants();drawResults();markDirty();
      });
      bottom.append(remove);card.append(bottom);list.append(card);
    }
  }
  function scoreOf(p,scoring) {
    if(p.status!=='OK'||!p.result) return null;
    const penalty=Number(p.penalty||0);
    if(scoring==='points'){
      const n=Number(p.result.replace(',','.'));
      return Number.isFinite(n)?n-penalty:null;
    }
    const bits=p.result.trim().split(':');
    if(bits.length<2||bits.length>3)return null;
    const last=Number(bits[bits.length-1].replace(',','.'));
    if(!Number.isFinite(last)||last<0||last>=60)return null;
    const minutes=Number(bits[bits.length-2]);
    if(!Number.isInteger(minutes)||minutes<0||(bits.length===3&&minutes>=60))return null;
    const hours=bits.length===3?Number(bits[0]):0;
    if(!Number.isInteger(hours)||hours<0)return null;
    return hours*3600+minutes*60+last+penalty;
  }
  function places(){
    const groups=new Map(),positions=new Map();
    for(const p of state.data.participants){
      const val=scoreOf(p,state.data.event.scoring);
      if(val===null)continue;
      const group=p.category||'Общий зачёт';
      if(!groups.has(group))groups.set(group,[]);
      groups.get(group).push({id:p.id,value:val});
    }
    for(const group of groups.values()){
      group.sort((a,b)=>state.data.event.scoring==='points'?b.value-a.value:a.value-b.value);
      group.forEach((item,index)=>{
        const place=index>0&&item.value===group[index-1].value?positions.get(group[index-1].id):index+1;
        positions.set(item.id,place);
      });
    }
    return positions;
  }
  function drawResults(){
    const list=$('resultList');list.replaceChildren();
    if(!state.data.participants.length){
      list.append(node('p','small muted','Добавь участников, чтобы появились строки результатов.'));
      return;
    }
    const ranked=places();
    for(const p of state.data.participants){
      const item=node('div','result-item');
      item.append(node('span','place',ranked.has(p.id)?ranked.get(p.id):'—'));
      const title=node('div');
      title.append(node('span','result-name',p.name||'Без имени'));
      title.append(node('span','result-category',p.category||'Общий зачёт'));
      item.append(title);
      const resultLabel=node('label','',state.data.event.scoring==='points'?'Баллы':'Время');
      const field=node('input');
      field.value=p.result||'';
      field.placeholder=state.data.event.scoring==='points'?'75':'5:30.20';
      field.maxLength=50;
      field.addEventListener('change',()=>{
        p.result=field.value;markDirty(true);
      });
      resultLabel.append(field);item.append(resultLabel);
      const status=node('select','status-select');
      for(const v of ['OK','DNS','DNF','DSQ']){
        const option=node('option','',v);
        option.value=v;option.selected=(p.status||'OK')===v;status.append(option);
      }
      status.addEventListener('change',()=>{p.status=status.value;markDirty(true);});
      const label=node('label','', 'Статус');label.append(status);item.append(label);
      list.append(item);
    }
  }
  function exportCurrent(){
    if(!state.data)return;
    fieldsToState();
    const text=JSON.stringify(state.data,null,2);
    const blob=new Blob([text],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=node('a');
    link.href=url;link.download='startpult_tournament_backup.json';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function bind(){
    $('authSwitch').addEventListener('click',()=>{state.register=!state.register;setMode();});
    $('authForm').addEventListener('submit',async event=>{
      event.preventDefault();
      const form=$('authForm'),button=$('authSubmit');
      button.disabled=true;
      try{
        const out=await api(state.register?'/api/auth/register':'/api/auth/login','POST',{
          email:form.elements.email.value,password:form.elements.password.value});
        form.reset();await afterLogin(out.user);toast('Вход выполнен');
      }catch(e){toast(e.message);}
      finally{button.disabled=false;}
    });
    $('logout').addEventListener('click',async()=>{
      if(state.dirty){const ok=await save();if(!ok||state.dirty)return;}
      try{await api('/api/auth/logout','POST',{});}catch(e){toast(e.message);return;}
      state.user=null;state.id=null;state.data=null;setAuth();
    });
    $('newTournament').addEventListener('click',async()=>{
      try{
        const data=await api('/api/tournaments','POST',{});
        await openTournament(data.id);
        $('eventName').focus();
      }catch(e){toast(e.message);}
    });
    $('back').addEventListener('click',()=>leaveEditor().catch(e=>toast(e.message)));
    $('save').addEventListener('click',()=>save().then(ok=>{if(ok)toast('Турнир сохранён');}).catch(e=>toast(e.message)));
    $('export').addEventListener('click',exportCurrent);
    $('addParticipant').addEventListener('click',()=>{
      const people=state.data.participants;
      const used=new Set(people.map(x=>x.bib));
      let bib=1;while(used.has(bib))bib++;
      if(people.length>=2500){toast('Лимит 2500 участников');return;}
      people.push({id:crypto.randomUUID(),bib,name:'',team:'',category:'Общий зачёт',
        result:'',penalty:0,status:'OK',paid:false});
      drawParticipants();drawResults();markDirty();
      $('participantList').lastElementChild?.scrollIntoView({behavior:'smooth',block:'nearest'});
    });
    for(const name of ['eventName','eventDate','eventSport','eventPlace','eventScoring','eventFee']){
      $(name).addEventListener('change',()=>{fieldsToState();markDirty(name==='eventScoring');});
    }
    $('deleteTournament').addEventListener('click',async()=>{
      if(!confirm('Удалить этот турнир и всех его участников без возможности восстановления?'))return;
      try{
        clearTimeout(state.timer);
        await api('/api/tournaments/'+state.id,'DELETE');
        state.dirty=false;state.id=null;state.data=null;
        $('editor').hidden=true;$('listing').hidden=false;
        await loadList();toast('Турнир удалён');
      }catch(e){toast(e.message);}
    });
    window.addEventListener('beforeunload',event=>{
      if(state.dirty){event.preventDefault();event.returnValue='';}
    });
  }
  bind();setMode();loadMe();
})();
