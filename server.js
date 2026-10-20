'use strict';
const express=require('express'),fs=require('fs'),path=require('path'),crypto=require('crypto'),QR=require('qrcode');
let nodemailer=null;try{nodemailer=require('nodemailer')}catch{}
const DATA=process.env.DATA_DIR||path.join(__dirname,'data'),UP=path.join(DATA,'uploads'),FILE=path.join(DATA,'db.json');
fs.mkdirSync(UP,{recursive:true});
const rnd=n=>crypto.randomBytes(n).toString('hex');
const hash=(pw,salt)=>crypto.scryptSync(String(pw),salt,32).toString('hex');
let db;
function save(){const t=FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(db));fs.renameSync(t,FILE)}
if(fs.existsSync(FILE))db=JSON.parse(fs.readFileSync(FILE));
else{
  db=JSON.parse(fs.readFileSync(path.join(__dirname,'seed.json')));
  db.secret=rnd(32);const salt=rnd(8);db.admin={salt,hash:hash(process.env.ADMIN_PASSWORD||'soko-admin-change-me',salt),default:!process.env.ADMIN_PASSWORD};
  db.tables=Array.from({length:8},(_,i)=>({id:i+1,label:'Table '+(i+1),token:rnd(12),active:true}));db.nextTable=9;db.orders=[];save();
}
const sign=s=>crypto.createHmac('sha256',db.secret).update(s).digest('hex');
const makeTok=()=>{const e=Date.now()+12*3600e3;return e+'.'+sign(String(e))};
const okTok=t=>{if(typeof t!=='string')return false;const[e,s]=t.split('.');return !!s&&Date.now()<+e&&crypto.timingSafeEqual(Buffer.from(sign(e)),Buffer.from(s.padEnd(64,'x').slice(0,64)))};
const hits=new Map();
const limit=(key,max,ms)=>{const n=Date.now(),a=(hits.get(key)||[]).filter(t=>n-t<ms);a.push(n);hits.set(key,a);return a.length>max};
const str=(v,m=200)=>String(v??'').trim().slice(0,m);
const clients=new Set();
const push=(ev,d)=>clients.forEach(r=>r.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`));
async function mail(to,subject,text){
  if(!nodemailer||!process.env.SMTP_URL||!to)return;
  try{await nodemailer.createTransport(process.env.SMTP_URL).sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER||'orders@localhost',to,subject,text})}catch(e){console.error('mail failed:',e.message)}
}
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);app.use(express.json({limit:'6mb'}));
app.use((q,r,n)=>{r.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin'});n()});
const tableBy=t=>db.tables.find(x=>x.active&&typeof t==='string'&&x.token===t);
// ---------- customer ----------
app.get('/api/menu',(q,r)=>{
  const t=tableBy(q.query.t);if(!t)return r.status(403).json({error:'This QR code is not valid. Please scan the code on your table.'});
  const s=db.settings;
  r.json({cafe:{name:s.name,tagline:s.tagline,open:s.open,taxPercent:s.taxPercent},table:t.label,categories:db.categories,items:db.items.filter(i=>i.today).map(({id,name,category,price,desc,ingredients,diet,inStock,image})=>({id,name,category,price,desc,ingredients,diet,inStock,image}))});
});
app.post('/api/order',async(q,r)=>{
  const b=q.body||{},t=tableBy(b.t);
  if(!t)return r.status(403).json({error:'Invalid or expired QR code. Please scan the code on your table again.'});
  if(!db.settings.open)return r.status(409).json({error:'We are not taking orders right now.'});
  if(limit('o'+q.ip+t.id,8,600e3))return r.status(429).json({error:'Too many orders. Please ask our staff.'});
  if(!Array.isArray(b.items)||!b.items.length||b.items.length>40)return r.status(400).json({error:'Your cart is empty.'});
  const lines=[];
  for(const l of b.items){
    const it=db.items.find(i=>i.id===l.id),qty=Math.floor(+l.qty);
    if(!it||!it.today)return r.status(409).json({error:'An item is no longer available. Please refresh the menu.'});
    if(!it.inStock)return r.status(409).json({error:it.name+' is out of stock.'});
    if(!(qty>=1&&qty<=20))return r.status(400).json({error:'Invalid quantity.'});
    lines.push({id:it.id,name:it.name,price:it.price,qty,diet:it.diet});
  }
  const sub=lines.reduce((a,l)=>a+l.price*l.qty,0),tax=Math.round(sub*db.settings.taxPercent)/100;
  const c=b.customer||{};
  const o={id:++db.seq,no:'SK-'+db.seq,tableId:t.id,table:t.label,items:lines,subtotal:sub,tax,total:sub+tax,note:str(b.note,300),customer:{name:str(c.name,60),phone:str(c.phone,20),email:str(c.email,100)},status:'new',createdAt:Date.now()};
  db.orders.push(o);if(db.orders.length>3000)db.orders.splice(0,500);save();
  push('order',o);
  const txt=lines.map(l=>`${l.qty} x ${l.name}`).join('\n');
  mail(db.settings.notifyEmail,`New order ${o.no} - ${t.label}`,`${t.label}\n${txt}\nTotal: Rs ${o.total}\nNote: ${o.note||'-'}`);
  mail(o.customer.email,`Your order ${o.no} is confirmed - ${db.settings.name}`,`Thank you${o.customer.name?' '+o.customer.name:''}! We have received your order for ${t.label}.\n${txt}\nTotal: Rs ${o.total}`);
  r.json({order:pub(o)});
});
const pub=o=>({id:o.id,no:o.no,table:o.table,items:o.items,total:o.total,tax:o.tax,status:o.status,createdAt:o.createdAt});
app.get('/api/order/:id',(q,r)=>{const o=db.orders.find(x=>x.id===+q.params.id),t=tableBy(q.query.t);if(!o||!t||o.tableId!==t.id)return r.status(404).json({error:'Not found'});r.json({order:pub(o)})});
// ---------- admin ----------
app.post('/api/admin/login',(q,r)=>{
  if(limit('l'+q.ip,6,60e3))return r.status(429).json({error:'Too many attempts. Wait a minute.'});
  const a=db.admin,h=hash(str(q.body?.password,200),a.salt);
  if(!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(a.hash)))return r.status(401).json({error:'Wrong password.'});
  r.json({token:makeTok(),defaultPassword:!!a.default});
});
const adm=(q,r,n)=>okTok(q.get('x-admin-token')||q.query.k)?n():r.status(401).json({error:'Session expired. Please log in again.'});
const A=express.Router();app.use('/api/admin',A);A.use((q,r,n)=>q.path==='/login'?n():adm(q,r,n));
const base=q=>db.settings.publicUrl||`${q.protocol}://${q.get('host')}`;
A.get('/state',(q,r)=>r.json({settings:db.settings,categories:db.categories,items:db.items,tables:db.tables,orders:db.orders.slice(-300),defaultPassword:!!db.admin.default,mailReady:!!(nodemailer&&process.env.SMTP_URL)}));
A.get('/stream',(q,r)=>{r.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});r.flushHeaders();r.write('retry: 3000\n\n');clients.add(r);const p=setInterval(()=>r.write(': ping\n\n'),25000);q.on('close',()=>{clearInterval(p);clients.delete(r)})});
const num=(v,d=0)=>{const n=Math.round(+v*100)/100;return Number.isFinite(n)&&n>=0&&n<100000?n:d};
function itemFrom(b,it){
  const cat=str(b.category,60)||'Other';if(!db.categories.includes(cat))db.categories.push(cat);
  const name=str(b.name,80);if(!name)throw Error('Dish name is required.');
  const img=str(b.image,200);if(img&&!/^\/uploads\/[\w.-]+$/.test(img))throw Error('Invalid image.');
  return Object.assign(it,{name,category:cat,price:num(b.price,it.price||0),desc:str(b.desc,300),ingredients:str(b.ingredients,300),diet:b.diet==='egg'?'egg':'veg',inStock:b.inStock!==false,today:b.today!==false,image:img});
}
const wrap=f=>(q,r)=>{try{f(q,r)}catch(e){r.status(400).json({error:e.message})}};
A.post('/items',wrap((q,r)=>{const it=itemFrom(q.body,{id:db.nextItem++});db.items.push(it);save();r.json(it)}));
A.put('/items/:id',wrap((q,r)=>{const it=db.items.find(i=>i.id===+q.params.id);if(!it)throw Error('Not found');itemFrom({...it,...q.body},it);save();r.json(it)}));
A.delete('/items/:id',(q,r)=>{db.items=db.items.filter(i=>i.id!==+q.params.id);save();r.json({ok:1})});
A.post('/upload',wrap((q,r)=>{
  const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(q.body?.dataUrl||'');if(!m)throw Error('Please upload a JPG, PNG or WebP image.');
  const buf=Buffer.from(m[2],'base64');if(buf.length>4e6)throw Error('Image must be under 4 MB.');
  const f=rnd(8)+'.'+(m[1]==='jpeg'?'jpg':m[1]);fs.writeFileSync(path.join(UP,f),buf);r.json({url:'/uploads/'+f});
}));
A.post('/tables',wrap((q,r)=>{const label=str(q.body.label,30);if(!label)throw Error('Table name is required.');const t={id:db.nextTable++,label,token:rnd(12),active:true};db.tables.push(t);save();r.json(t)}));
A.put('/tables/:id',wrap((q,r)=>{const t=db.tables.find(x=>x.id===+q.params.id);if(!t)throw Error('Not found');if(q.body.label!==undefined)t.label=str(q.body.label,30)||t.label;if(q.body.active!==undefined)t.active=!!q.body.active;if(q.body.rotate)t.token=rnd(12);save();r.json(t)}));
A.post('/tables-rotate-all',(q,r)=>{db.tables.forEach(t=>t.token=rnd(12));save();r.json(db.tables)});
A.delete('/tables/:id',(q,r)=>{db.tables=db.tables.filter(t=>t.id!==+q.params.id);save();r.json({ok:1})});
A.get('/qr/:id',async(q,r)=>{const t=db.tables.find(x=>x.id===+q.params.id);if(!t)return r.sendStatus(404);const url=`${base(q)}/t/${t.token}`;r.json({url,png:await QR.toDataURL(url,{width:600,margin:1,color:{dark:'#234D43',light:'#FFFFFF'}})})});
const ST=['new','preparing','ready','served','cancelled'];
A.patch('/orders/:id',wrap((q,r)=>{const o=db.orders.find(x=>x.id===+q.params.id);if(!o||!ST.includes(q.body.status))throw Error('Invalid');o.status=q.body.status;save();r.json(o);
  if(o.status==='ready')mail(o.customer.email,`Order ${o.no} is ready`,`Your order is ready at ${o.table}.`)}));
A.put('/settings',wrap((q,r)=>{const b=q.body,s=db.settings;for(const k of['name','tagline','phone','email','notifyEmail','notifyPhone'])if(b[k]!==undefined)s[k]=str(b[k],100);
  if(b.publicUrl!==undefined){const u=str(b.publicUrl,200).replace(/\/+$/,'');if(u&&!/^https?:\/\/[\w.:-]+$/.test(u))throw Error('Public URL must look like https://yourcafe.com');s.publicUrl=u}
  if(b.taxPercent!==undefined)s.taxPercent=Math.min(num(b.taxPercent),50);if(b.open!==undefined)s.open=!!b.open;save();r.json(s)}));
A.post('/password',wrap((q,r)=>{const p=str(q.body.password,200);if(p.length<8)throw Error('Use at least 8 characters.');const salt=rnd(8);db.admin={salt,hash:hash(p,salt),default:false};db.secret=rnd(32);save();r.json({token:makeTok()})}));
A.post('/categories',wrap((q,r)=>{const c=str(q.body.name,60);if(!c)throw Error('Name required');if(!db.categories.includes(c))db.categories.push(c);save();r.json(db.categories)}));
// ---------- pages ----------
const P=f=>(q,r)=>r.sendFile(path.join(__dirname,'public',f));
app.get('/t/:tok',P('customer.html'));app.get('/admin',P('admin.html'));app.get('/',P('landing.html'));
app.use('/uploads',express.static(UP,{maxAge:'7d'}));app.use(express.static(path.join(__dirname,'public')));
app.use((e,q,r,n)=>r.status(e.status||500).json({error:e.status===413?'Image too large.':'Something went wrong.'}));
const port=process.env.PORT||3000;app.listen(port,()=>console.log(`SOKO ordering running on http://localhost:${port}  (admin: /admin)`+(db.admin.default?'\n!! Default admin password in use: set ADMIN_PASSWORD or change it in Settings.':'')));
