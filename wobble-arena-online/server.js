'use strict';
/* =====================================================================
   WOBBLE ARENA ONLINE - game server
   Needs only Node.js (no extra packages).   Run:  node server.js
   Then open http://localhost:3000 in a browser.

   Anti-cheat: the server owns every game. It picks all the random
   timings, never tells the browser what is coming, times every key
   press itself, rejects reactions faster than a human can manage,
   and caps how fast keys can be mashed.
   ===================================================================== */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {performance}=require('perf_hooks');
const PORT=process.env.PORT||3000;
const now=()=>performance.now();
const rand=(a,b)=>a+Math.random()*(b-a);
const pick=a=>a[Math.floor(Math.random()*a.length)];
const MAX_PLAYERS=6,MIN_REACTION=100,MAX_LAG_CREDIT=120;

/* ---------------- web page ---------------- */
const PAGE=path.join(__dirname,'public','index.html');
const server=http.createServer((req,res)=>{
  const url=(req.url||'/').split('?')[0];
  if(url==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return;}
  if(url==='/'||url==='/index.html'){
    fs.readFile(PAGE,(err,data)=>{
      if(err){res.writeHead(500);res.end('index.html is missing');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(data);
    });return;
  }
  res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');
});

/* ---------------- minimal WebSocket server ---------------- */
class Conn{
  constructor(sock){
    this.sock=sock;this.buf=Buffer.alloc(0);this.alive=true;this.p=null;this.msgN=0;this.msgT=0;
    sock.on('data',d=>this.onData(d));sock.on('close',()=>this.closed());sock.on('error',()=>this.closed());
  }
  onData(d){
    this.buf=Buffer.concat([this.buf,d]);
    if(this.buf.length>65536){this.kill();return;}
    for(;;){
      if(this.buf.length<2)return;
      const b0=this.buf[0],b1=this.buf[1],op=b0&15;let len=b1&127,off=2;
      if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);off=4;}
      else if(len===127){this.kill();return;}
      if(!(b1&128)){this.kill();return;}
      if(this.buf.length<off+4+len)return;
      const mask=this.buf.subarray(off,off+4),data=Buffer.from(this.buf.subarray(off+4,off+4+len));
      for(let i=0;i<len;i++)data[i]^=mask[i&3];
      this.buf=this.buf.subarray(off+4+len);
      if(op===8){this.kill();return;}
      if(op===9){this.frame(10,data);continue;}
      if(op!==1||!(b0&128))continue;
      /* flood guard: at most 80 messages a second */
      const t=now();if(t-this.msgT>1000){this.msgT=t;this.msgN=0;}
      if(++this.msgN>80)continue;
      let m;try{m=JSON.parse(data.toString('utf8'));}catch(e){continue;}
      if(m&&typeof m==='object'){try{onMsg(this,m,t);}catch(e){console.error(e);}}
    }
  }
  frame(op,payload){
    if(!this.alive)return;const len=payload.length;let h;
    if(len<126)h=Buffer.from([128|op,len]);
    else{h=Buffer.alloc(4);h[0]=128|op;h[1]=126;h.writeUInt16BE(Math.min(len,65535),2);}
    try{this.sock.write(Buffer.concat([h,payload]));}catch(e){}
  }
  send(o){this.frame(1,Buffer.from(JSON.stringify(o)));}
  kill(){if(!this.alive)return;this.alive=false;try{this.sock.destroy();}catch(e){}leave(this);}
  closed(){if(!this.alive)return;this.alive=false;leave(this);}
}
server.on('upgrade',(req,sock)=>{
  const key=req.headers['sec-websocket-key'];
  if(String(req.headers.upgrade||'').toLowerCase()!=='websocket'||!key){sock.destroy();return;}
  const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  sock.setNoDelay(true);new Conn(sock);
});

/* ---------------- ranks without a database ----------------
   Each player's rank lives in their own browser as a "card" signed by this
   server. A card cannot be edited without the SECRET, so set a SECRET
   environment variable on your host or ranks reset whenever the server restarts. */
const SECRET=process.env.SECRET||crypto.randomBytes(24).toString('hex');
if(!process.env.SECRET)console.log('Note: no SECRET is set, so player ranks will reset when the server restarts.');
const mac=body=>crypto.createHmac('sha256',SECRET).update(body).digest('hex').slice(0,32);
function sign(card){const body=Buffer.from(JSON.stringify(card)).toString('base64url');return body+'.'+mac(body);}
function readCard(tok){
  if(typeof tok==='string'&&tok.length<400){
    const i=tok.lastIndexOf('.'),body=tok.slice(0,i),m=tok.slice(i+1),good=mac(body);
    if(i>0&&m.length===good.length&&crypto.timingSafeEqual(Buffer.from(m),Buffer.from(good))){
      try{const c=JSON.parse(Buffer.from(body,'base64url').toString());if(c&&typeof c.u==='string'&&typeof c.r==='number')return{u:c.u.slice(0,32),r:c.r,g:c.g|0,w:c.w|0};}catch(e){}
    }
  }
  return{u:crypto.randomBytes(8).toString('hex'),r:1000,g:0,w:0};
}
function sendCard(p,d){p.conn.send({t:'card',tok:sign(p.card),r:p.card.r,g:p.card.g,w:p.card.w,d:d==null?null:d});}
/* rank: [{p,key}] best first, equal keys are a tie. Everyone is compared with everyone else. */
function rate(rank,K){
  const n=rank.length,out={};if(n<2)return out;const pos=[];let cur=0;
  rank.forEach((x,i)=>{if(i>0&&x.key!==rank[i-1].key)cur=i;pos.push(cur);});
  const old=rank.map(x=>x.p.card.r);
  rank.forEach((x,i)=>{
    let S=0,E=0;for(let j=0;j<n;j++){if(j===i)continue;S+=pos[i]<pos[j]?1:pos[i]===pos[j]?0.5:0;E+=1/(1+Math.pow(10,(old[j]-old[i])/400));}
    const d=Math.round(K*(S-E)/(n-1)),c=x.p.card;c.r=Math.max(100,old[i]+d);c.g++;if(pos[i]===0)c.w++;
    out[x.p.id]={d:d,r:c.r};sendCard(x.p,d);
  });
  return out;
}

/* ---------------- players and rooms ---------------- */
const rooms=new Map();let nextId=1;
const HEX=/^#[0-9a-fA-F]{6}$/;
function cleanName(s){s=String(s==null?'':s).replace(/[^\p{L}\p{N} _\-]/gu,'').trim().slice(0,12);return s||'Player';}
function cleanAv(a){
  a=a&&typeof a==='object'?a:{};const col=(v,d)=>HEX.test(String(v))?String(v):d,int=(v,n)=>{v=Math.floor(Number(v));return v>=0&&v<n?v:0;};
  return{skin:col(a.skin,'#efc29a'),hairC:col(a.hairC,'#5a3a1e'),shirt:col(a.shirt,'#457b9d'),hair:int(a.hair,6),eyes:int(a.eyes,4)};
}
function newCode(){for(;;){let c='';for(let i=0;i<4;i++)c+=pick('ABCDEFGHJKLMNPQRSTUVWXYZ');if(!rooms.has(c))return c;}}
function lagCredit(p){return p.rtts.length?Math.min(Math.min.apply(null,p.rtts),MAX_LAG_CREDIT):0;}
function roomState(r){
  const players=r.players.map(p=>({id:p.id,name:p.name,av:p.av,wins:p.wins,r:p.card.r,ping:p.rtts.length?Math.round(Math.min.apply(null,p.rtts)):null}));
  const startIn=r.startAt?Math.max(0,Math.round(r.startAt-now())):null;
  for(const p of r.players)p.conn.send({t:'room',code:r.code,you:p.id,host:r.host.id,players:players,playing:!!r.game||!!r.party,pub:r.pub||null,startIn:startIn});
}
function addPlayer(conn,r,m){
  const p={id:nextId++,conn:conn,name:cleanName(m.name),av:cleanAv(m.av),room:r,wins:0,rtts:[],pings:new Map(),lastPong:now(),card:readCard(m.tok),lastEmote:0};
  p.av.name=p.name;conn.p=p;r.players.push(p);if(!r.host)r.host=p;sendCard(p,null);refresh(r);
}
function leave(conn){
  const p=conn.p;if(!p)return;conn.p=null;const r=p.room;if(!r)return;
  r.players=r.players.filter(x=>x!==p);
  if(r.game)r.game.drop(p);
  if(r.party)r.party.drop(p);
  if(!r.players.length){clearTimeout(r.timer);rooms.delete(r.code);return;}
  if(r.host===p)r.host=r.players[0];
  refresh(r);
}
/* ---------------- public matchmaking ---------------- */
function findPublic(mode,card){
  let best=null;
  for(const r of rooms.values()){
    if(r.pub!==mode||r.players.length>=MAX_PLAYERS||(mode==='party'&&r.party)||r.players.some(p=>p.card.u===card.u))continue;
    if(!best||r.players.length>best.players.length)best=r;
  }
  return best;
}
function schedule(r){
  if(!r.pub||!rooms.has(r.code))return;
  if(r.game||r.party||r.players.length<2){clearTimeout(r.timer);r.timer=null;r.startAt=null;return;}
  const want=now()+(r.players.length>=MAX_PLAYERS?4000:r.cool?15000:12000);
  if(r.timer&&r.startAt<=want)return;
  clearTimeout(r.timer);r.startAt=want;r.timer=setTimeout(()=>launch(r),want-now());
}
function refresh(r){schedule(r);roomState(r);}
function launch(r){
  r.timer=null;r.startAt=null;r.cool=false;
  if(!rooms.has(r.code)||r.game||r.party||r.players.length<2)return;
  if(r.pub==='party'){r.party=new Party(r,5);roomState(r);return;}
  let id=null;
  for(let tries=0;tries<40&&!id;tries++){if(!r.bag||!r.bag.length)r.bag=shuffle(Object.keys(GAMES));const c=r.bag.pop();if(GAMES[c].min<=r.players.length)id=c;}
  r.game=new GAMES[id||'draw'].c(r,id||'draw');roomState(r);r.game.start();
}
setInterval(()=>{
  const t=now();
  for(const r of rooms.values())for(const p of r.players.slice()){
    if(t-p.lastPong>20000){p.conn.kill();continue;}
    const id=nextId++;p.pings.set(id,t);if(p.pings.size>10)p.pings.delete(p.pings.keys().next().value);
    p.conn.send({t:'ping',id:id});
  }
},2000);

/* ---------------- games ---------------- */
class Game{
  constructor(room,name,players){this.room=room;this.name=name;this.players=(players||room.players).slice();this.timers=[];this.over=false;this.sc=new Map(this.players.map(p=>[p,0]));}
  after(ms,fn){const h=setTimeout(()=>{if(!this.over){try{fn();}catch(e){console.error(e);}}},ms);this.timers.push(h);return h;}
  /* one round deadline at a time: starting a new one, or resolving early, cancels the old one */
  deadline(ms,fn){clearTimeout(this._dl);this._dl=this.after(ms,fn);}
  clearDeadline(){clearTimeout(this._dl);}
  every(ms,fn){const h=setInterval(()=>{if(!this.over)fn();},ms);this.timers.push(h);}
  send(o){o.t='g';o.g=this.name;for(const p of this.players)p.conn.send(o);}
  scores(){const o={};for(const [p,v] of this.sc)o[p.id]=v;return o;}
  stop(){this.over=true;for(const h of this.timers){clearTimeout(h);clearInterval(h);}if(this.room.game===this)this.room.game=null;}
  drop(p){this.players=this.players.filter(x=>x!==p);this.sc.delete(p);if(!this.players.length)this.stop();else if(this.onDrop)this.onDrop(p);}
  /* rank: array of {p,score,note}, best first */
  finish(rank){
    if(this.over)return;this.stop();
    if(this.room.party){this.room.party.roundDone(rank);return;}
    if(rank.length>1&&rank[0])rank[0].p.wins++;
    const out=rank.map(r=>({id:r.p.id,score:r.score,note:r.note||''}));
    const rated=this.room.pub?rate(rank.map(r=>({p:r.p,key:r.key!==undefined?r.key:r.note})),40):{};
    for(const p of this.players)p.conn.send({t:'over',g:this.name,rank:out,rate:rated});
    this.room.cool=true;refresh(this.room);
  }
  byScore(unit){return this.players.slice().sort((a,b)=>this.sc.get(b)-this.sc.get(a)).map(p=>({p:p,score:this.sc.get(p),note:this.sc.get(p)+' '+(this.sc.get(p)===1?unit.replace(/s$/,''):unit)}));}
}

const FAKES=['DRAWER!','DRAMA!','DRAGON!','DRAIN!','DROOL!','DRAWN!','DRAT!','DRAWL!','DRUM!'];
class QuickDraw extends Game{
  start(){this.target=3;this.round=0;this.send({ev:'intro',target:this.target});this.after(3500,()=>this.next());}
  next(){
    this.round++;this.phase='wait';this.fouls=new Set();this.shots=new Map();this.send({ev:'steady',round:this.round});
    const wait=rand(1800,4800),used=[];
    for(let i=0;i<2;i++){
      if(Math.random()>0.45)continue;const at=rand(600,wait-700);
      if(at<500||used.some(u=>Math.abs(u-at)<650))continue;used.push(at);const word=pick(FAKES);
      this.after(at,()=>{if(this.phase==='wait')this.send({ev:'fake',word:word});});
    }
    this.after(wait,()=>{if(this.phase!=='wait')return;this.phase='draw';this.at=now();this.send({ev:'draw'});this.deadline(1600,()=>this.resolve());});
  }
  allIn(){return this.players.every(p=>this.fouls.has(p)||this.shots.has(p));}
  key(p,k,t){
    if(k!=='fire'||this.fouls.has(p)||this.shots.has(p))return;
    if(this.phase==='wait'){this.fouls.add(p);this.send({ev:'foul',id:p.id,why:'early'});if(this.allIn())this.after(600,()=>this.resolve());}
    else if(this.phase==='draw'){
      const rt=t-this.at-lagCredit(p);
      if(rt<MIN_REACTION){this.fouls.add(p);this.send({ev:'foul',id:p.id,why:'fast'});}
      else{this.shots.set(p,rt);this.send({ev:'shot',id:p.id});}
      if(this.allIn())this.resolve();
    }
  }
  onDrop(){if((this.phase==='wait'||this.phase==='draw')&&this.allIn())this.resolve();}
  resolve(){
    if(this.phase==='res')return;this.phase='res';this.clearDeadline();
    let win=null,best=Infinity;const times={};
    for(const [p,rt] of this.shots){times[p.id]=Math.round(rt);if(rt<best){best=rt;win=p;}}
    if(win&&this.sc.has(win))this.sc.set(win,this.sc.get(win)+1);
    this.send({ev:'res',winner:win?win.id:null,times:times,scores:this.scores()});
    const done=(win&&this.sc.get(win)>=this.target)||this.round>=20;
    this.after(done?2800:3200,()=>{if(done)this.finish(this.byScore('rounds'));else this.next();});
  }
}

const SDIR={up:0,right:1,down:2,left:3};
class FlySwat extends Game{
  start(){this.dur=30000;this.bugs=[];this.nextBug=1;this.st=new Map(this.players.map(p=>[p,{cool:0,stun:0}]));this.send({ev:'intro'});
    this.after(3500,()=>{this.t0=now();this.send({ev:'go',dur:this.dur});this.spawn();this.after(this.dur,()=>this.finish(this.byScore('swats')));});}
  spawn(){
    const el=now()-this.t0,prog=el/this.dur;if(el>this.dur-500)return;
    const free=[0,1,2,3].filter(s=>!this.bugs.some(b=>b.s===s&&!b.dead));
    if(free.length){this.add(pick(free),Math.random()<0.27?'wasp':'fly',prog);
      if(prog>0.4&&free.length>1&&Math.random()<0.3){const f2=[0,1,2,3].filter(s=>!this.bugs.some(b=>b.s===s&&!b.dead));if(f2.length)this.add(pick(f2),Math.random()<0.5?'wasp':'fly',prog);}}
    this.after(rand(480,950)-250*prog,()=>this.spawn());
  }
  add(s,k,prog){
    const D=Math.round((1150-420*prog)*rand(0.9,1.15)),b={id:this.nextBug++,s:s,k:k,at:now(),D:D,claims:[],dead:false};
    this.bugs.push(b);this.send({ev:'bug',id:b.id,s:s,k:k,D:D});
    this.after(D+MAX_LAG_CREDIT,()=>{if(!b.dead&&!b.claims.length){b.dead=true;this.send({ev:'gone',id:b.id});}this.bugs=this.bugs.filter(x=>!x.dead);});
    this.after(D,()=>{if(!b.dead)this.send({ev:'gone',id:b.id,soft:true});});
  }
  key(p,k,t){
    const s=SDIR[k],st=this.st.get(p);if(s===undefined||!st||this.t0===undefined||t<st.cool||t<st.stun)return;
    const b=this.bugs.find(x=>x.s===s&&!x.dead),rt=b?t-b.at-lagCredit(p):0;
    if(!b||rt<MIN_REACTION||rt>b.D){st.cool=t+300;this.send({ev:'miss',id:p.id,s:s});return;}
    if(b.claims.some(c=>c.p===p))return;
    b.claims.push({p:p,rt:rt});st.cool=t+90;this.send({ev:'swat',id:p.id,s:s});
    /* wait a moment so a player with a slower connection still gets a fair shot */
    if(b.claims.length===1)this.after(90,()=>this.award(b));
  }
  award(b){
    if(b.dead)return;b.dead=true;const live=b.claims.filter(c=>this.sc.has(c.p));if(!live.length){this.send({ev:'gone',id:b.id});return;}
    if(b.k==='fly'){const w=live.reduce((a,c)=>c.rt<a.rt?c:a);this.sc.set(w.p,this.sc.get(w.p)+1);this.send({ev:'hit',bug:b.id,s:b.s,id:w.p.id,scores:this.scores()});}
    else{const ids=[];for(const c of live){this.sc.set(c.p,Math.max(0,this.sc.get(c.p)-2));this.st.get(c.p).stun=now()+900;ids.push(c.p.id);}this.send({ev:'sting',bug:b.id,s:b.s,ids:ids,scores:this.scores()});}
  }
}

const KDIR={left:-1,right:1,up:0,down:0};
class Keeper extends Game{
  start(){this.total=7;this.n=0;this.rtSum=new Map(this.players.map(p=>[p,0]));this.send({ev:'intro',total:this.total});this.after(3500,()=>this.next());}
  next(){
    this.n++;this.phase='run';this.dives=new Map();this.send({ev:'run',n:this.n,total:this.total});
    const wait=rand(1700,3600);
    if(Math.random()<0.6){const at=rand(500,wait-700);this.after(at,()=>{if(this.phase==='run')this.send({ev:'stutter'});});}
    this.after(wait,()=>{this.phase='shot';this.dir=pick([-1,0,1]);this.F=Math.round(640-32*this.n);this.at=now();this.send({ev:'kick',dir:this.dir,F:this.F});this.deadline(this.F+MAX_LAG_CREDIT+60,()=>this.resolve());});
  }
  key(p,k,t){
    const d=KDIR[k];if(d===undefined||this.dives.has(p))return;
    if(this.phase==='run'){this.dives.set(p,{d:d,early:true});this.send({ev:'dive',id:p.id,d:d,early:true});}
    else if(this.phase==='shot'){const rt=t-this.at-lagCredit(p);this.dives.set(p,{d:d,rt:rt,early:rt<MIN_REACTION});this.send({ev:'dive',id:p.id,d:d});}
  }
  resolve(){
    if(this.phase!=='shot')return;this.phase='res';const out={};let fast=null,best=Infinity;
    for(const p of this.players){
      const dv=this.dives.get(p),ok=!!dv&&!dv.early&&dv.d===this.dir&&dv.rt<=this.F;
      out[p.id]={ok:ok,rt:dv&&dv.rt!=null?Math.round(dv.rt):null,why:!dv?'slow':dv.early?'early':dv.d!==this.dir?'wrong':ok?'':'slow'};
      if(ok){this.sc.set(p,this.sc.get(p)+1);this.rtSum.set(p,this.rtSum.get(p)+dv.rt);if(dv.rt<best){best=dv.rt;fast=p;}}
    }
    if(fast&&this.players.length>1)this.sc.set(fast,this.sc.get(fast)+1);
    this.send({ev:'res',dir:this.dir,saves:out,bonus:fast&&this.players.length>1?fast.id:null,scores:this.scores()});
    this.after(2800,()=>{if(this.n>=this.total)this.finish(this.byScore('points'));else this.next();});
  }
}

class MashDash extends Game{
  start(){this.len=this.LEN||100;this.st=new Map(this.players.map(p=>[p,{x:0,last:'',lt:0,fin:null}]));this.send({ev:'intro',len:this.len});
    this.after(3500,()=>{this.t0=now();this.send({ev:'go'});if(this.onGo)this.onGo();this.every(70,()=>this.tick());this.after(45000,()=>this.end());});}
  tick(){const pos={};for(const [p,s] of this.st)pos[p.id]=s.x;this.send({ev:'pos',pos:pos});}
  key(p,k,t){
    const s=this.st.get(p);if(!s||this.t0===undefined||s.fin!==null||(k!=='z'&&k!=='x'))return;
    /* keys must alternate, and nobody mashes faster than 22 presses a second */
    if(k===s.last||t-s.lt<45)return;
    s.last=k;s.lt=t;s.x++;
    if(s.x>=this.len){
      s.fin=Math.max(0,t-this.t0-lagCredit(p)/2);this.send({ev:'fin',id:p.id,time:Math.round(s.fin)});
      const left=[...this.st.values()].filter(v=>v.fin===null).length;
      if(!left)this.after(1500,()=>this.end());else if(!this.closing){this.closing=true;this.after(7000,()=>this.end());}
    }
  }
  onDrop(p){this.st.delete(p);if(this.t0!==undefined&&[...this.st.values()].every(v=>v.fin!==null))this.end();}
  end(){
    this.tick();
    const rank=this.players.slice().sort((a,b)=>{const A=this.st.get(a),B=this.st.get(b);if(A.fin!==null&&B.fin!==null)return A.fin-B.fin;if(A.fin!==null)return -1;if(B.fin!==null)return 1;return B.x-A.x;})
      .map(p=>{const s=this.st.get(p);return{p:p,score:s.fin!==null?Math.round(s.fin):null,note:s.fin!==null?(s.fin/1000).toFixed(2)+'s':s.x+' m'};});
    this.finish(rank);
  }
}
class RedLight extends MashDash{
  onGo(){this.red=false;this.redAt=0;this.flip();}
  flip(){this.after(this.red?rand(1200,2600):rand(1400,4200),()=>{this.red=!this.red;this.redAt=now();this.send({ev:'light',red:this.red});this.flip();});}
  key(p,k,t){
    if(this.red){
      const s=this.st.get(p);if(!s||s.fin!==null||(k!=='z'&&k!=='x'))return;
      /* a short grace period after the light changes, then moving costs you 8 metres */
      if(t-this.redAt>280+lagCredit(p)&&s.caught!==this.redAt){s.caught=this.redAt;s.x=Math.max(0,s.x-8);this.send({ev:'caught',id:p.id});}
      return;
    }
    super.key(p,k,t);
  }
}
RedLight.prototype.LEN=60;

class HotPotato extends Game{
  start(){this.alive=this.players.slice();this.out=[];this.passes=0;this.holder=null;this.send({ev:'intro'});this.after(3500,()=>this.give(pick(this.alive),true));}
  give(p,fresh){
    this.holder=p;this.dir=Math.floor(Math.random()*4);this.holdAt=now();this.lock=0;
    if(fresh)this.after(rand(6000,14000),()=>this.explode());
    this.send({ev:'hold',id:p.id,dir:this.dir});
  }
  key(p,k,t){
    if(p!==this.holder||SDIR[k]===undefined||t<this.lock||t-this.holdAt-lagCredit(p)<MIN_REACTION)return;
    if(SDIR[k]!==this.dir){this.lock=t+500;this.send({ev:'wrong',id:p.id});return;}
    this.passes++;const others=this.alive.filter(x=>x!==p);this.give(others.length?pick(others):p,false);
  }
  explode(){
    const p=this.holder;if(!p)return;this.holder=null;this.alive=this.alive.filter(x=>x!==p);this.out.push(p);this.send({ev:'boom',id:p.id});
    this.after(2600,()=>{if(this.alive.length<=1)this.done();else this.give(pick(this.alive),true);});
  }
  onDrop(p){
    this.alive=this.alive.filter(x=>x!==p);this.out=this.out.filter(x=>x!==p);
    if(this.alive.length<=1){this.done();return;}
    if(this.holder===p)this.give(pick(this.alive),false);
  }
  done(){
    const rank=this.alive.map(p=>({p:p,score:0,note:'survivor',key:'w'}));
    this.out.slice().reverse().forEach((p,i)=>rank.push({p:p,score:0,note:this.players.length>1?'blown up':this.passes+' passes',key:'o'+i}));
    this.finish(rank);
  }
}

class CopyCat extends Game{
  start(){this.alive=this.players.slice();this.best=new Map(this.players.map(p=>[p,0]));this.len=2;this.send({ev:'intro'});this.after(3500,()=>this.round());}
  round(){
    this.len++;this.phase='show';this.seq=[];for(let i=0;i<this.len;i++)this.seq.push(Math.floor(Math.random()*4));
    this.idx=new Map(this.alive.map(p=>[p,0]));this.state=new Map();
    this.send({ev:'show',seq:this.seq,alive:this.alive.map(p=>p.id)});
    this.after(this.len*600+900,()=>{this.phase='input';this.send({ev:'input'});this.deadline(this.len*1100+2500,()=>this.endRound());});
  }
  key(p,k){
    const d=SDIR[k];if(this.phase!=='input'||d===undefined||!this.idx.has(p)||this.state.has(p))return;
    const i=this.idx.get(p);
    if(d!==this.seq[i]){this.state.set(p,'fail');this.send({ev:'fail',id:p.id});}
    else{this.idx.set(p,i+1);if(i+1>=this.len){this.state.set(p,'done');this.best.set(p,this.len);this.send({ev:'done',id:p.id});}else this.send({ev:'prog',id:p.id,n:i+1});}
    if(this.alive.every(x=>this.state.has(x)))this.endRound();
  }
  endRound(){
    if(this.phase!=='input')return;this.phase='res';this.clearDeadline();
    const ok=this.alive.filter(p=>this.state.get(p)==='done'),out=this.alive.filter(p=>ok.indexOf(p)<0);
    this.send({ev:'rres',out:out.map(p=>p.id)});
    const end=!ok.length||this.len>=10||(ok.length===1&&this.players.length>1);this.alive=ok;
    this.after(2400,()=>{
      if(!end){this.round();return;}
      this.finish(this.players.slice().sort((a,b)=>this.best.get(b)-this.best.get(a)).map(p=>({p:p,score:this.best.get(p),note:this.best.get(p)+' arrows'})));
    });
  }
  onDrop(p){this.alive=this.alive.filter(x=>x!==p);this.best.delete(p);if(this.phase==='input'&&this.alive.every(x=>this.state.has(x)))this.endRound();}
}

const WORDS=['planet','rocket','banana','castle','dragon','guitar','jungle','kitten','ladder','magnet','orange','pencil','rabbit','saddle','tunnel','violin','window','yellow','zipper','anchor','bridge','candle','desert','engine','forest','garden','hammer','island','jacket','kettle','lemon','monkey','needle','oyster','pirate','quiver','ribbon','silver','ticket','umpire','velvet','walrus','wizard','button','cactus','donkey','falcon','goblin','helmet','insect','jigsaw','karate','lizard','muffin','napkin','parrot','sponge','turtle','waffle','biscuit','penguin','rainbow','sausage','trumpet','volcano','whistle'];
class WordDash extends Game{
  start(){this.n=0;this.total=5;this.used=new Set();this.send({ev:'intro'});this.after(3500,()=>this.next());}
  next(){
    this.n++;do{this.word=pick(WORDS);}while(this.used.has(this.word));this.used.add(this.word);
    this.idx=new Map(this.players.map(p=>[p,0]));this.fin=new Map();this.phase='type';this.at=now();
    this.send({ev:'word',w:this.word,n:this.n,total:this.total});this.deadline(9000,()=>this.endWord());
  }
  key(p,k,t){
    if(this.phase!=='type'||k.length!==2||k[0]!=='l'||this.fin.has(p)||!this.idx.has(p))return;
    const i=this.idx.get(p);
    if(k[1]!==this.word[i]){this.idx.set(p,0);this.send({ev:'typo',id:p.id});return;}
    this.idx.set(p,i+1);
    if(i+1<this.word.length){this.send({ev:'prog',id:p.id,n:i+1});return;}
    const rt=t-this.at-lagCredit(p);
    /* nobody types a whole word this fast */
    if(rt<this.word.length*45){this.idx.set(p,0);this.send({ev:'typo',id:p.id});return;}
    this.fin.set(p,rt);this.send({ev:'typed',id:p.id});
    if(this.players.every(x=>this.fin.has(x)))this.endWord();
  }
  onDrop(){if(this.phase==='type'&&this.players.every(x=>this.fin.has(x)))this.endWord();}
  endWord(){
    if(this.phase!=='type')return;this.phase='res';this.clearDeadline();
    const order=[...this.fin.entries()].filter(e=>this.sc.has(e[0])).sort((a,b)=>a[1]-b[1]).map(e=>e[0]);
    order.forEach((p,i)=>this.sc.set(p,this.sc.get(p)+([4,3,2][i]||1)));
    this.send({ev:'wres',order:order.map(p=>p.id),scores:this.scores()});
    this.after(2200,()=>{if(this.n>=this.total)this.finish(this.byScore('points'));else this.next();});
  }
}

class LastSeat extends Game{
  start(){this.alive=this.players.slice();this.out=[];this.r=0;this.send({ev:'intro'});this.after(3500,()=>this.music());}
  music(){
    this.r++;this.phase='music';this.early=new Set();this.sat=new Map();this.send({ev:'music',alive:this.alive.map(p=>p.id),round:this.r});
    const wait=rand(2500,7000);
    if(Math.random()<0.5){const at=rand(800,wait-900);if(at>600)this.after(at,()=>{if(this.phase==='music')this.send({ev:'skip'});});}
    this.after(wait,()=>{if(this.phase!=='music')return;this.phase='sit';this.at=now();this.send({ev:'stop'});this.deadline(1800,()=>this.resolve());});
  }
  key(p,k,t){
    if(k!=='fire'||this.alive.indexOf(p)<0||this.early.has(p)||this.sat.has(p))return;
    if(this.phase==='music'){this.early.add(p);this.send({ev:'early',id:p.id});}
    else if(this.phase==='sit'){
      const rt=t-this.at-lagCredit(p);
      if(rt<MIN_REACTION){this.early.add(p);this.send({ev:'early',id:p.id});}else{this.sat.set(p,rt);this.send({ev:'sat',id:p.id});}
      if(this.alive.every(x=>this.early.has(x)||this.sat.has(x)))this.resolve();
    }
  }
  resolve(){
    if(this.phase!=='sit')return;this.phase='res';this.clearDeadline();let out=[];
    const early=this.alive.filter(p=>this.early.has(p)),none=this.alive.filter(p=>!this.early.has(p)&&!this.sat.has(p));
    if(early.length+none.length>0){if(early.length+none.length<this.alive.length)out=early.concat(none);}
    else if(this.alive.length>1){let slow=null,w=-1;for(const [p,rt] of this.sat)if(rt>w){w=rt;slow=p;}out=[slow];}
    this.alive=this.alive.filter(p=>out.indexOf(p)<0);for(const p of out)this.out.push({p:p,r:this.r});
    const times={};for(const [p,rt] of this.sat)times[p.id]=Math.round(rt);
    this.send({ev:'res',out:out.map(p=>p.id),times:times,alive:this.alive.map(p=>p.id)});
    this.after(2800,()=>{if(this.alive.length<=1||this.r>=15)this.done();else this.music();});
  }
  onDrop(p){this.alive=this.alive.filter(x=>x!==p);this.out=this.out.filter(o=>o.p!==p);if(this.alive.length<=1)this.done();}
  done(){
    const rank=this.alive.map(p=>({p:p,score:0,note:'last one sitting',key:'w'}));
    this.out.slice().reverse().forEach(o=>rank.push({p:o.p,score:0,note:'out in round '+o.r,key:'r'+o.r}));
    this.finish(rank);
  }
}

class StopClock extends Game{
  start(){this.n=0;this.total=3;this.err=new Map(this.players.map(p=>[p,0]));this.send({ev:'intro'});this.after(3500,()=>this.next());}
  next(){
    this.n++;this.target=Math.round(rand(30,70))*100;this.press=new Map();this.phase='ready';
    this.send({ev:'clock',target:this.target,n:this.n,total:this.total});
    this.after(1800,()=>{this.phase='run';this.at=now();this.send({ev:'run'});this.deadline(this.target+3000,()=>this.resolve());});
  }
  key(p,k,t){
    if(k!=='fire'||this.phase!=='run'||this.press.has(p)||!this.err.has(p))return;
    const el=t-this.at-lagCredit(p)/2;if(el<300)return;
    this.press.set(p,el-this.target);this.send({ev:'stopped',id:p.id});
    if(this.players.every(x=>this.press.has(x)))this.resolve();
  }
  onDrop(p){this.err.delete(p);if(this.phase==='run'&&this.players.every(x=>this.press.has(x)))this.resolve();}
  resolve(){
    if(this.phase!=='run')return;this.phase='res';this.clearDeadline();const errs={},tot={};
    for(const p of this.players){const e=this.press.has(p)?this.press.get(p):3000;errs[p.id]=Math.round(e);this.err.set(p,this.err.get(p)+Math.min(3000,Math.abs(e)));tot[p.id]=Math.round(this.err.get(p));}
    this.send({ev:'res',errs:errs,tot:tot});
    this.after(3600,()=>{
      if(this.n<this.total){this.next();return;}
      this.finish(this.players.slice().sort((a,b)=>this.err.get(a)-this.err.get(b)).map(p=>({p:p,score:Math.round(this.err.get(p)),note:(this.err.get(p)/1000).toFixed(2)+'s off'})));
    });
  }
}

/* four games share one engine: a question with four answers on the arrow keys */
class Choice extends Game{
  start(){this.n=0;this.total=8;this.send({ev:'intro',kind:this.kind});this.after(3500,()=>this.wait());}
  wait(){this.phase='wait';this.send({ev:'ready'});this.after(rand(900,2300),()=>this.ask());}
  ask(){this.n++;const q=this.gen();this.ans=q.ans;this.answers=new Map();this.phase='ask';this.at=now();this.send({ev:'q',n:this.n,total:this.total,q:q.show});this.deadline(4000,()=>this.resolve());}
  key(p,k,t){
    const d=SDIR[k];if(this.phase!=='ask'||d===undefined||this.answers.has(p)||!this.sc.has(p))return;
    const rt=t-this.at-lagCredit(p);this.answers.set(p,{d:d,rt:rt,ok:d===this.ans&&rt>=MIN_REACTION});this.send({ev:'ansd',id:p.id});
    if(this.players.every(x=>this.answers.has(x)))this.resolve();
  }
  onDrop(){if(this.phase==='ask'&&this.players.every(x=>this.answers.has(x)))this.resolve();}
  resolve(){
    if(this.phase!=='ask')return;this.phase='res';this.clearDeadline();let fast=null,best=Infinity;const res={};
    for(const p of this.players){
      const a=this.answers.get(p);res[p.id]=a?{ok:a.ok,d:a.d,rt:Math.round(a.rt)}:null;
      if(a&&a.ok){this.sc.set(p,this.sc.get(p)+1);if(a.rt<best){best=a.rt;fast=p;}}else if(a)this.sc.set(p,Math.max(0,this.sc.get(p)-1));
    }
    if(fast&&this.players.length>1)this.sc.set(fast,this.sc.get(fast)+1);
    this.send({ev:'a',ans:this.ans,res:res,fast:fast&&this.players.length>1?fast.id:null,scores:this.scores()});
    this.after(2300,()=>{if(this.n>=this.total)this.finish(this.byScore('points'));else this.wait();});
  }
}
const r4=()=>Math.floor(Math.random()*4);
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
class Stroop extends Choice{gen(){const w=r4(),ink=Math.random()<0.25?w:(w+1+Math.floor(Math.random()*3))%4;return{show:{word:w,ink:ink},ans:ink};}}
Stroop.prototype.kind='colour';
class Maths extends Choice{
  gen(){
    const op=pick(['+','-','x']);let a,b,v;
    if(op==='+'){a=Math.floor(rand(6,49));b=Math.floor(rand(6,49));v=a+b;}else if(op==='-'){a=Math.floor(rand(20,90));b=Math.floor(rand(5,a-2));v=a-b;}else{a=Math.floor(rand(3,13));b=Math.floor(rand(3,13));v=a*b;}
    const set=new Set([v]);const cand=shuffle([v+1,v-1,v+2,v-2,v+10,v-10,v+(op==='x'?a:5),v-(op==='x'?b:5)]).filter(x=>x>0);
    for(const c of cand){if(set.size>=4)break;set.add(c);}
    const opts=shuffle([...set]);return{show:{text:a+' '+op+' '+b,opts:opts},ans:opts.indexOf(v)};
  }
}
Maths.prototype.kind='maths';
const PAIRS=[['😀','😄'],['🐱','🐯'],['🍊','🍑'],['⚽','🏐'],['🌝','🌞'],['🐸','🐢'],['🍎','🍅'],['🐶','🐻'],['🚗','🚕'],['🍋','🍌'],['🌲','🌳'],['🐧','🐦']];
class OddOne extends Choice{gen(){const pr=pick(PAIRS),flip=Math.random()<0.5,a=pr[flip?1:0],b=pr[flip?0:1],pos=r4(),opts=[a,a,a,a];opts[pos]=b;return{show:{opts:opts},ans:pos};}}
OddOne.prototype.kind='odd';
class Opposite extends Choice{gen(){const d=r4(),same=Math.random()<0.3;return{show:{arrow:d,same:same},ans:same?d:(d+2)%4};}}
Opposite.prototype.kind='opp';

const GAMES={draw:{c:QuickDraw,min:1},swat:{c:FlySwat,min:1},keeper:{c:Keeper,min:1},dash:{c:MashDash,min:1},red:{c:RedLight,min:1},potato:{c:HotPotato,min:2},copy:{c:CopyCat,min:1},
  word:{c:WordDash,min:1},seat:{c:LastSeat,min:2},clock:{c:StopClock,min:1},colour:{c:Stroop,min:1},maths:{c:Maths,min:1},odd:{c:OddOne,min:1},opp:{c:Opposite,min:1}};

/* ---------------- Party Mode: mystery games, podium points and secret cards ---------------- */
const PTS=[10,7,5,3,2,1],CARDS=['double','halve','shield'];
class Party{
  constructor(room,rounds){
    this.room=room;this.rounds=rounds;this.n=0;this.players=room.players.slice();this.total=new Map(this.players.map(p=>[p,0]));
    this.hand=new Map();this.plays=new Map();this.bag=[];this.lastGame=null;this.phase='pick';
    this.send({ev:'pick',rounds:rounds});this.timer=setTimeout(()=>this.beginRound(),25000);
  }
  send(o,only){o.t='party';for(const p of(only?[only]:this.players))p.conn.send(o);}
  totals(){const o={};for(const [p,v] of this.total)o[p.id]=v;return o;}
  pick(p,arr){
    if(this.phase!=='pick'||this.hand.has(p)||!this.total.has(p)||!Array.isArray(arr)||arr.length!==2||arr[0]===arr[1]||CARDS.indexOf(arr[0])<0||CARDS.indexOf(arr[1])<0)return;
    this.hand.set(p,new Set(arr));this.send({ev:'picked',id:p.id});
    if(this.players.every(x=>this.hand.has(x)))this.beginRound();
  }
  beginRound(){
    clearTimeout(this.timer);if(this.phase==='over')return;
    for(const p of this.players)if(!this.hand.has(p))this.hand.set(p,new Set(['double','halve']));
    this.n++;this.phase='cards';this.plays=new Map();const t=this.totals();
    for(const p of this.players)this.send({ev:'round',n:this.n,of:this.rounds,totals:t,hand:[...this.hand.get(p)]},p);
    this.timer=setTimeout(()=>this.startGame(),12000);
  }
  play(p,card,target){
    if(this.phase!=='cards'||this.plays.has(p)||!this.total.has(p))return;
    if(card==='none')this.plays.set(p,null);
    else{
      const h=this.hand.get(p);if(!h||!h.has(card))return;let tg=null;
      if(card==='halve'){tg=this.players.find(x=>x.id===target&&x!==p);if(!tg)return;}
      h.delete(card);this.plays.set(p,{card:card,target:tg});
    }
    this.send({ev:'locked',id:p.id});
    if(this.players.every(x=>this.plays.has(x))){clearTimeout(this.timer);this.timer=setTimeout(()=>this.startGame(),700);}
  }
  startGame(){
    clearTimeout(this.timer);if(this.phase!=='cards')return;this.phase='game';
    if(!this.bag.length)this.bag=shuffle(Object.keys(GAMES).filter(id=>GAMES[id].min<=this.players.length));
    let i=this.bag.length-1;if(this.bag[i]===this.lastGame&&i>0)i--;
    const id=this.bag.splice(i,1)[0];this.lastGame=id;
    const g=new GAMES[id].c(this.room,id,this.players);this.room.game=g;this.send({ev:'game',g:id});g.start();
  }
  roundDone(rank){
    if(this.phase!=='game')return;this.phase='reveal';const rows=[];let pos=0,prev=null;
    rank.filter(r=>this.total.has(r.p)).forEach((r,i)=>{const key=r.key!==undefined?r.key:r.note;if(i===0||key!==prev)pos=i;prev=key;rows.push({p:r.p,pos:pos,base:PTS[Math.min(pos,PTS.length-1)],note:r.note});});
    for(const row of rows){const pl=this.plays.get(row.p);row.double=!!pl&&pl.card==='double';row.shield=!!pl&&pl.card==='shield';row.halvedBy=[];row.blocked=[];row.pts=row.base*(row.double?2:1);}
    for(const [p,pl] of this.plays){
      if(!pl||pl.card!=='halve')continue;const row=rows.find(r=>r.p===pl.target);if(!row)continue;
      if(row.shield&&!row.blocked.length)row.blocked.push(p.id);else{row.halvedBy.push(p.id);row.pts=Math.ceil(row.pts/2);}
    }
    for(const row of rows)this.total.set(row.p,this.total.get(row.p)+row.pts);
    const last=this.n>=this.rounds;
    this.send({ev:'reveal',n:this.n,of:this.rounds,last:last,rows:rows.map(r=>({id:r.p.id,pos:r.pos,base:r.base,note:r.note,double:r.double,shield:r.shield,halvedBy:r.halvedBy,blocked:r.blocked,pts:r.pts,total:this.total.get(r.p)}))});
    this.timer=setTimeout(()=>{if(last)this.end(true);else this.beginRound();},11000);
  }
  drop(p){
    this.players=this.players.filter(x=>x!==p);this.total.delete(p);this.hand.delete(p);this.plays.delete(p);
    if(!this.players.length){this.end(false);return;}
    if(this.phase==='pick'&&this.players.every(x=>this.hand.has(x)))this.beginRound();
    else if(this.phase==='cards'&&this.players.every(x=>this.plays.has(x)))this.startGame();
    else if(this.phase==='game'&&!this.room.game){this.phase='reveal';this.timer=setTimeout(()=>this.beginRound(),500);}
  }
  end(final){
    clearTimeout(this.timer);this.phase='over';this.room.party=null;
    if(final){
      const order=this.players.slice().sort((a,b)=>this.total.get(b)-this.total.get(a));
      if(order.length>1)order[0].wins++;
      const rated=this.room.pub?rate(order.map(p=>({p:p,key:this.total.get(p)})),80):{};
      this.send({ev:'final',order:order.map(p=>({id:p.id,total:this.total.get(p)})),rate:rated});
    }
    if(rooms.has(this.room.code)){this.room.cool=true;refresh(this.room);}
  }
}

/* ---------------- messages from browsers ---------------- */
function onMsg(conn,m,t){
  const p=conn.p;
  if(m.t==='create'){
    if(p)return;if(rooms.size>=500){conn.send({t:'err',msg:'The server is full. Try again later.'});return;}
    const r={code:newCode(),players:[],host:null,game:null,party:null};rooms.set(r.code,r);addPlayer(conn,r,m);
  }else if(m.t==='join'){
    if(p)return;const r=rooms.get(String(m.code||'').toUpperCase().trim());
    if(!r){conn.send({t:'err',msg:'No room with that code.'});return;}
    if(r.players.length>=MAX_PLAYERS){conn.send({t:'err',msg:'That room is full.'});return;}
    addPlayer(conn,r,m);
  }else if(m.t==='match'){
    if(p||(m.mode!=='quick'&&m.mode!=='party'))return;
    if(rooms.size>=500){conn.send({t:'err',msg:'The server is full. Try again later.'});return;}
    let r=findPublic(m.mode,readCard(m.tok));
    if(!r){r={code:newCode(),players:[],host:null,game:null,party:null,pub:m.mode,timer:null,startAt:null,cool:false,bag:null};rooms.set(r.code,r);}
    addPlayer(conn,r,m);
  }else if(!p)return;
  else if(m.t==='pong'){const s=p.pings.get(m.id);if(s!==undefined){p.pings.delete(m.id);p.lastPong=t;p.rtts.push(t-s);if(p.rtts.length>6)p.rtts.shift();}}
  else if(m.t==='start'){
    const r=p.room,G=Object.prototype.hasOwnProperty.call(GAMES,m.game)?GAMES[m.game]:null;
    if(!G||r.pub||r.host!==p||r.game||r.party||r.players.length<G.min)return;
    r.game=new G.c(r,m.game);roomState(r);r.game.start();
  }else if(m.t==='party'){
    const r=p.room;if(r.pub||r.host!==p||r.game||r.party||(m.rounds!==5&&m.rounds!==10))return;
    r.party=new Party(r,m.rounds);roomState(r);
  }else if(m.t==='cards'){if(p.room.party)p.room.party.pick(p,m.pick);}
  else if(m.t==='play'){if(p.room.party&&typeof m.card==='string')p.room.party.play(p,m.card,m.target);}
  else if(m.t==='key'){
    const g=p.room.game;if(g&&!g.over&&typeof m.k==='string'&&m.k.length<8&&g.players.includes(p))g.key(p,m.k,t);
  }else if(m.t==='emote'){
    const e=m.e|0;if(e<1||e>6||t-p.lastEmote<500)return;p.lastEmote=t;
    for(const x of p.room.players)x.conn.send({t:'emote',id:p.id,e:e});
  }else if(m.t==='leave'){leave(conn);conn.send({t:'left'});}
}

server.listen(PORT,()=>console.log('Wobble Arena Online is running. Open http://localhost:'+PORT+' in your browser.'));
