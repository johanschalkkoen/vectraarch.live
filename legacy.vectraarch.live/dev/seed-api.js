'use strict';
/**
 * API-based seed script — works against any running instance.
 *
 * Usage:
 *   node dev/seed-api.js <baseUrl> <adminUsername> <adminPassword>
 *
 * Example (live site):
 *   node dev/seed-api.js https://legacy.vectraarch.live yourAdmin yourPassword
 *
 * Example (local):
 *   node dev/seed-api.js http://localhost:3300 johank koen2026
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const BASE  = (process.argv[2] || 'http://localhost:3300').replace(/\/$/, '');
const ADMIN = process.argv[3] || 'johank';
const PASS  = process.argv[4] || 'koen2026';

if (!process.argv[2]) {
  console.log('Usage: node dev/seed-api.js <baseUrl> <adminUsername> <adminPassword>');
  console.log('Example: node dev/seed-api.js https://legacy.vectraarch.live myAdmin myPass');
  process.exit(0);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(BASE + path);
    const lib    = url.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json', ...(data ? {'Content-Length': Buffer.byteLength(data)} : {}) },
      rejectUnauthorized: false,  // allow self-signed certs
    };
    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get  = (path)       => request('GET',    path,  null);
const post = (path, body) => request('POST',   path,  body);
const del  = (path, body) => request('DELETE', path,  body);

// ── date helpers ──────────────────────────────────────────────────────────────
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function pad(n) { return String(n).padStart(2,'0'); }
function dt(y,m,day) { return `${y}-${pad(m)}-${pad(day)}`; }
function dayOfWeek(ds) { return DAYS[new Date(ds+'T12:00:00').getDay()]; }
function daysInMonth(y,m) { return new Date(y,m,0).getDate(); }

// ── CLEAR existing data ───────────────────────────────────────────────────────
async function clearData(users) {
  console.log('Clearing existing data...');
  for (const u of users) {
    const un = u.username;
    const fin  = await get(`/api/financial?user=${un}`);
    if (Array.isArray(fin))  for (const r of fin)  await del(`/api/financial/${r.id}`,  {user:un});
    const bud  = await get(`/api/budget?user=${un}`);
    if (Array.isArray(bud))  for (const r of bud)  await del(`/api/budget/${r.id}`,    {user:un});
    const cal  = await get(`/api/calendar?user=${un}`);
    if (Array.isArray(cal))  for (const r of cal)  await del(`/api/calendar/${r.id}`,  {user:un});
    const gym  = await get(`/api/gymworkout?user=${un}`);
    if (Array.isArray(gym))  for (const r of gym)  await del(`/api/gymworkout/${r.id}`,{user:un});
    const meal = await get(`/api/mealplan?user=${un}`);
    if (Array.isArray(meal)) for (const r of meal) await del(`/api/mealplan/${r.id}`,  {user:un});
    const per  = await get(`/api/period?user=${un}`);
    if (Array.isArray(per))  for (const r of per)  await del(`/api/period/${r.id}`,    {user:un});
    console.log(`  cleared ${un}`);
  }
}

// ── FINANCIAL ─────────────────────────────────────────────────────────────────
function getFinancialRows(gender, isChild, m) {
  const idx = m % 5;
  if (!isChild && gender !== 'Female') {
    // Adult Male
    const freelance = [8500,12000,6500,14000,9000][idx];
    return [
      {category:'Salary',                amount:55000,              type:'income',  day:25},
      {category:'Freelance Consulting',   amount:freelance,          type:'income',  day:3},
      {category:'Investment Dividend',    amount:2800,               type:'income',  day:15},
      {category:'Mortgage',               amount:15200,              type:'expense', day:1},
      {category:'Car Payment',            amount:5480,               type:'expense', day:3},
      {category:'Car Insurance',          amount:1850,               type:'expense', day:3},
      {category:'Medical Aid',            amount:4200,               type:'expense', day:5},
      {category:'School Fees',            amount:4800,               type:'expense', day:7},
      {category:'Life Insurance',         amount:980,                type:'expense', day:5},
      {category:'Rates & Taxes',          amount:1650,               type:'expense', day:10},
      {category:'Electricity',            amount:1100,               type:'expense', day:12},
      {category:'Internet & Fibre',       amount:699,                type:'expense', day:4},
      {category:'Groceries – Pick n Pay', amount:3800,               type:'expense', day:8},
      {category:'Groceries – Woolworths', amount:1200,               type:'expense', day:20},
      {category:'Fuel',                   amount:[1600,1750,1900,1680,1720][idx], type:'expense', day:10},
      {category:'Fuel',                   amount:[800,900,1100,750,850][idx],    type:'expense', day:22},
      {category:'Gym Membership',         amount:950,                type:'expense', day:1},
      {category:'Dining Out',             amount:[2100,1850,2400,1950,2200][idx], type:'expense', day:18},
      {category:'Entertainment',          amount:[800,1200,600,900,750][idx],    type:'expense', day:21},
      {category:'Clothing',               amount:[1500,0,2200,0,1800][idx],      type:'expense', day:16},
      {category:'Home Maintenance',       amount:[0,2500,0,1800,0][idx],         type:'expense', day:14},
      {category:'Savings Transfer',       amount:8000,               type:'expense', day:26},
    ].filter(r=>r.amount>0);
  }
  if (!isChild && gender === 'Female') {
    // Adult Female
    const consult = [9000,0,11500,0,8500][idx];
    return [
      {category:'Salary',                 amount:38000,              type:'income',  day:25},
      ...(consult?[{category:'Consulting Fee', amount:consult,       type:'income',  day:12}]:[]),
      {category:'Car Payment',            amount:4200,               type:'expense', day:3},
      {category:'Car Insurance',          amount:1250,               type:'expense', day:3},
      {category:'Gym & Pilates Studio',   amount:650,                type:'expense', day:1},
      {category:'Clothing',               amount:[2800,1500,3200,1800,2200][idx], type:'expense', day:14},
      {category:'Personal Care & Beauty', amount:[1400,1800,1200,1600,1500][idx], type:'expense', day:18},
      {category:'Groceries',              amount:2500,               type:'expense', day:9},
      {category:'Dining Out',             amount:[1200,900,1500,1100,1300][idx],  type:'expense', day:20},
      {category:'Pharmacy',               amount:[350,600,280,400,320][idx],      type:'expense', day:15},
      {category:'Streaming Services',     amount:280,                type:'expense', day:4},
      {category:'Savings',                amount:5000,               type:'expense', day:26},
      {category:'Kids Activities',        amount:[1200,0,1500,800,1000][idx],     type:'expense', day:8},
    ].filter(r=>r.amount>0);
  }
  if (isChild && gender !== 'Female') {
    // Boy/Teen Male
    return [
      {category:'Monthly Allowance',  amount:2000,                      type:'income',  day:1},
      {category:'Gaming',             amount:[800,1200,600,950,700][idx], type:'expense', day:10},
      {category:'Snacks & Tuck Shop', amount:[320,280,350,300,260][idx],  type:'expense', day:15},
      {category:'Clothing',           amount:[0,500,0,800,0][idx],        type:'expense', day:20},
      {category:'School Supplies',    amount:[250,0,350,0,180][idx],      type:'expense', day:5},
      {category:'Airtime & Data',     amount:200,                         type:'expense', day:3},
    ].filter(r=>r.amount>0);
  }
  // Girl/Teen Female
  return [
    {category:'Monthly Allowance',      amount:1800,                          type:'income',  day:1},
    {category:'Part-time Job',          amount:[3500,3200,3800,3400,3600][idx], type:'income', day:28},
    {category:'Beauty & Nails',         amount:[680,900,560,780,720][idx],     type:'expense', day:16},
    {category:'Clothing & Fashion',     amount:[1200,800,1500,900,1100][idx],  type:'expense', day:18},
    {category:'Coffee & Cafes',         amount:[420,380,460,350,400][idx],     type:'expense', day:20},
    {category:'Streaming & Digital',    amount:280,                            type:'expense', day:4},
    {category:'Dance Classes',          amount:650,                            type:'expense', day:2},
    {category:'Airtime & Data',         amount:200,                            type:'expense', day:3},
    {category:'Savings',                amount:1000,                           type:'expense', day:28},
  ].filter(r=>r.amount>0);
}

async function seedFinancial(users) {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const u of users) {
    const isChild  = (u.gender||'').toLowerCase()==='boy' || (u.age && parseInt(u.age)<20);
    // Treat users without explicit adult marker who are female as adult female, male as adult male
    // Heuristic: if username contains 'kid'/'son'/'daughter'/'boy'/'girl' → child
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(u.username);
    const isFemale  = (u.gender||'').toLowerCase()==='female';
    for (const [y,m] of months) {
      const maxDay = m===5 ? 21 : daysInMonth(y,m);
      const rows = getFinancialRows(u.gender, childHint, m);
      for (const r of rows) {
        const day = Math.min(r.day, maxDay);
        await post('/api/financial', {
          user: u.username, category: r.category,
          amount: r.amount, type: r.type,
          date: dt(y,m,day), eventColor: u.eventColor||'#2dd4bf',
        });
      }
    }
    console.log(`  financial done: ${u.username}`);
  }
}

// ── BUDGET ────────────────────────────────────────────────────────────────────
async function seedBudget(users) {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const u of users) {
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(u.username);
    const isFemale  = (u.gender||'').toLowerCase()==='female';
    for (const [y,m] of months) {
      const idx = m%5;
      let income, expenses;
      if (!childHint && !isFemale) {
        income = 55000+[8500,12000,6500,14000,9000][idx]+2800;
        expenses = [
          {description:'Mortgage',           amount:15200},
          {description:'Car & Insurance',    amount:7330},
          {description:'Medical & Life',     amount:5180},
          {description:'School Fees',        amount:4800},
          {description:'Utilities',          amount:3449},
          {description:'Groceries',          amount:5000},
          {description:'Fuel',               amount:[2400,2650,3000,2430,2570][idx]},
          {description:'Gym',                amount:950},
          {description:'Dining & Entertainment', amount:[2900,3050,3000,2850,2950][idx]},
          {description:'Savings',            amount:8000},
        ];
      } else if (!childHint && isFemale) {
        income = 38000+[9000,0,11500,0,8500][idx];
        expenses = [
          {description:'Car & Insurance',    amount:5450},
          {description:'Gym & Pilates',      amount:650},
          {description:'Clothing & Beauty',  amount:[4200,3300,4400,3400,3700][idx]},
          {description:'Groceries',          amount:2500},
          {description:'Dining Out',         amount:[1200,900,1500,1100,1300][idx]},
          {description:'Kids Activities',    amount:[1200,0,1500,800,1000][idx]},
          {description:'Savings',            amount:5000},
        ].filter(e=>e.amount>0);
      } else if (childHint && !isFemale) {
        income = 2000;
        expenses = [
          {description:'Gaming',    amount:[800,1200,600,950,700][idx]},
          {description:'Snacks',    amount:[320,280,350,300,260][idx]},
          {description:'Airtime',   amount:200},
        ];
      } else {
        income = 1800+[3500,3200,3800,3400,3600][idx];
        expenses = [
          {description:'Beauty & Fashion',   amount:[1880,1700,2060,1680,1820][idx]},
          {description:'Coffee & Cafes',     amount:[420,380,460,350,400][idx]},
          {description:'Dance Classes',      amount:650},
          {description:'Streaming',          amount:280},
          {description:'Savings',            amount:1000},
        ];
      }
      await post('/api/budget', {
        user: u.username, income, expenses: JSON.stringify(expenses),
        date: dt(y,m,1), budget_type: 'need',
      });
    }
    console.log(`  budget done: ${u.username}`);
  }
}

// ── CALENDAR ──────────────────────────────────────────────────────────────────
async function seedCalendar(users) {
  // Build per-user event lists based on gender/role
  for (const u of users) {
    const un = u.username;
    const c  = u.eventColor || '#2dd4bf';
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(un);
    const isFemale  = (u.gender||'').toLowerCase()==='female';

    let events = [];
    if (!childHint && !isFemale) {
      events = [
        {title:'Team Standup',       dates:['2026-01-06','2026-01-13','2026-01-20','2026-01-27','2026-02-03','2026-02-10','2026-02-17','2026-02-24','2026-03-03','2026-03-10','2026-03-17','2026-03-24','2026-03-31','2026-04-07','2026-04-14','2026-04-22','2026-04-28','2026-05-05','2026-05-12','2026-05-19'], time:'08:30:00'},
        {title:'Client Presentation',dates:['2026-01-15','2026-02-19','2026-03-26','2026-04-30','2026-05-14'], time:'10:00:00'},
        {title:'Project Deadline',   dates:['2026-01-31','2026-02-28','2026-03-31','2026-04-30','2026-05-21'], time:'17:00:00'},
        {title:'Car Service',        dates:['2026-02-14'], time:'09:00:00'},
        {title:'Dentist Appointment',dates:['2026-04-16'], time:'14:00:00'},
        {title:'Family Braai',       dates:['2026-01-18','2026-02-22','2026-04-12','2026-05-10'], time:'12:00:00'},
        {title:'Family Holiday',     dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00'},
      ];
    } else if (!childHint && isFemale) {
      events = [
        {title:'Hospital Shift',     dates:['2026-01-07','2026-01-08','2026-01-14','2026-01-15','2026-02-04','2026-02-05','2026-02-11','2026-03-04','2026-03-05','2026-03-11','2026-04-01','2026-04-02','2026-04-08','2026-05-06','2026-05-07','2026-05-13'], time:'07:00:00'},
        {title:'Pilates Class',      dates:['2026-01-05','2026-01-12','2026-01-19','2026-01-26','2026-02-02','2026-02-09','2026-02-16','2026-02-23','2026-03-02','2026-03-09','2026-03-16','2026-03-23','2026-03-30','2026-04-06','2026-04-13','2026-04-20','2026-04-27','2026-05-04','2026-05-11','2026-05-18'], time:'06:30:00'},
        {title:'Parent-Teacher Meeting',dates:['2026-02-26','2026-05-07'], time:'15:30:00'},
        {title:'Gynae Appointment',  dates:['2026-03-18'], time:'10:00:00'},
        {title:'Girls Night Out',    dates:['2026-01-24','2026-03-28','2026-05-16'], time:'19:00:00'},
        {title:'Meal Prep Sunday',   dates:['2026-01-11','2026-01-25','2026-02-08','2026-02-22','2026-03-08','2026-03-22','2026-04-05','2026-04-19','2026-05-03','2026-05-17'], time:'10:00:00'},
        {title:'Family Holiday',     dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00'},
      ];
    } else if (childHint && !isFemale) {
      events = [
        {title:'School Exam',        dates:['2026-01-28','2026-01-29','2026-01-30'], time:'08:00:00'},
        {title:'Rugby Practice',     dates:['2026-01-06','2026-01-08','2026-01-13','2026-01-15','2026-01-20','2026-01-22','2026-01-27','2026-01-29','2026-02-03','2026-02-05','2026-02-10','2026-02-12','2026-02-17','2026-02-19','2026-02-24','2026-02-26','2026-03-03','2026-03-05','2026-03-10','2026-03-12','2026-03-17','2026-03-19','2026-03-24','2026-03-26','2026-04-02','2026-04-07','2026-04-09','2026-04-14','2026-04-21','2026-04-23','2026-04-28','2026-04-30','2026-05-05','2026-05-07','2026-05-12','2026-05-14','2026-05-19','2026-05-21'], time:'15:30:00'},
        {title:'Gaming Session',     dates:['2026-01-10','2026-01-17','2026-01-24','2026-01-31','2026-02-07','2026-02-14','2026-02-21','2026-02-28','2026-03-07','2026-03-14','2026-03-21','2026-03-28','2026-04-04','2026-04-11','2026-04-18','2026-04-25','2026-05-02','2026-05-09','2026-05-16'], time:'18:00:00'},
        {title:'Family Holiday',     dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00'},
      ];
    } else {
      events = [
        {title:'Dance Rehearsal',    dates:['2026-01-05','2026-01-07','2026-01-12','2026-01-14','2026-01-19','2026-01-21','2026-01-26','2026-01-28','2026-02-02','2026-02-04','2026-02-09','2026-02-11','2026-02-16','2026-02-18','2026-02-23','2026-02-25','2026-03-02','2026-03-04','2026-03-09','2026-03-11','2026-03-16','2026-03-18','2026-03-23','2026-03-25','2026-03-30','2026-04-01','2026-04-06','2026-04-08','2026-04-13','2026-04-15','2026-04-20','2026-04-22','2026-04-27','2026-04-29','2026-05-04','2026-05-06','2026-05-11','2026-05-13','2026-05-18','2026-05-20'], time:'16:00:00'},
        {title:'Coffee with Friends',dates:['2026-01-10','2026-01-17','2026-01-24','2026-01-31','2026-02-07','2026-02-14','2026-02-21','2026-02-28','2026-03-07','2026-03-14','2026-03-21','2026-03-28','2026-04-04','2026-04-11','2026-04-18','2026-04-25','2026-05-02','2026-05-09','2026-05-16'], time:'11:00:00'},
        {title:'Work Shift – Café',  dates:['2026-01-06','2026-01-08','2026-01-13','2026-01-15','2026-01-20','2026-01-22','2026-01-27','2026-01-29','2026-02-03','2026-02-05','2026-02-10','2026-02-12','2026-02-17','2026-02-19','2026-02-24','2026-02-26','2026-03-03','2026-03-05','2026-03-10','2026-03-12','2026-03-17','2026-03-19','2026-03-24','2026-03-26','2026-03-31','2026-04-02','2026-04-07','2026-04-09','2026-04-14','2026-04-16','2026-04-21','2026-04-23','2026-04-28','2026-04-30','2026-05-05','2026-05-07','2026-05-12','2026-05-14','2026-05-19','2026-05-21'], time:'07:00:00'},
        {title:'Gynaecology Check-up',dates:['2026-02-10','2026-05-12'], time:'10:00:00'},
        {title:'Family Holiday',     dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00'},
      ];
    }

    for (const ev of events) {
      for (const date of ev.dates) {
        await post('/api/calendar', {
          user: un, title: ev.title,
          date: `${date} ${ev.time}`,
          eventColor: c,
        });
      }
    }
    console.log(`  calendar done: ${un}`);
  }
}

// ── GYM ───────────────────────────────────────────────────────────────────────
const GYM_ROUTINES = {
  adultMale: {
    Monday:    [{e:'Flat Barbell Bench Press',s:4,r:'8',w:'100kg'},{e:'Incline Barbell Press',s:3,r:'10',w:'80kg'},{e:'Dumbbell Chest Flyes',s:3,r:'12',w:'24kg'},{e:'Tricep Pushdown',s:4,r:'12',w:'40kg'},{e:'Skull Crushers',s:3,r:'10',w:'45kg'}],
    Wednesday: [{e:'Conventional Deadlift',s:4,r:'5',w:'160kg'},{e:'Pendlay Row',s:4,r:'8',w:'100kg'},{e:'Pull-ups (Weighted)',s:3,r:'8',w:'+20kg'},{e:'Lat Pulldown',s:3,r:'12',w:'70kg'},{e:'Barbell Curl',s:4,r:'10',w:'50kg'}],
    Thursday:  [{e:'Barbell Back Squat',s:4,r:'8',w:'140kg'},{e:'Leg Press',s:4,r:'12',w:'200kg'},{e:'Romanian Deadlift',s:3,r:'10',w:'100kg'},{e:'Hamstring Curl',s:3,r:'12',w:'50kg'},{e:'Standing Calf Raise',s:4,r:'20',w:'80kg'}],
    Saturday:  [{e:'Overhead Press',s:4,r:'8',w:'80kg'},{e:'Seated DB Press',s:3,r:'10',w:'30kg'},{e:'Lateral Raise',s:4,r:'15',w:'12kg'},{e:'Cable Face Pull',s:3,r:'15',w:'30kg'},{e:'Barbell Shrugs',s:3,r:'12',w:'80kg'}],
  },
  adultFemale: {
    Monday:    [{e:'Yoga Flow',s:1,r:'45m',w:'bodyweight'},{e:'Hip Flexor Stretch',s:2,r:'30s',w:'bodyweight'},{e:'Shoulder Mobility',s:2,r:'30s',w:'bodyweight'}],
    Wednesday: [{e:'HIIT Circuit',s:1,r:'30m',w:'bodyweight'},{e:'Jump Rope',s:4,r:'3m',w:'bodyweight'},{e:'Burpees',s:3,r:'20',w:'bodyweight'}],
    Friday:    [{e:'Lat Pulldown',s:3,r:'12',w:'45kg'},{e:'Seated DB Press',s:3,r:'12',w:'10kg'},{e:'Romanian Deadlift',s:3,r:'12',w:'40kg'},{e:'Seated Cable Row',s:3,r:'12',w:'40kg'},{e:'Plank',s:3,r:'60s',w:'bodyweight'}],
    Sunday:    [{e:'Treadmill Run',s:1,r:'5km',w:'bodyweight'},{e:'Stationary Bike',s:1,r:'20m',w:'bodyweight'}],
  },
  teenMale: {
    Tuesday:   [{e:'Flat Barbell Bench Press',s:3,r:'10',w:'60kg'},{e:'Dumbbell Curl',s:3,r:'12',w:'16kg'},{e:'Pull-ups (Weighted)',s:3,r:'8',w:'bodyweight'},{e:'Tricep Dips',s:3,r:'12',w:'bodyweight'},{e:'Ab Wheel Rollout',s:3,r:'15',w:'bodyweight'}],
    Thursday:  [{e:'Barbell Back Squat',s:3,r:'10',w:'80kg'},{e:'Leg Press',s:3,r:'15',w:'120kg'},{e:'Standing Calf Raise',s:4,r:'20',w:'60kg'},{e:'Plank',s:3,r:'45s',w:'bodyweight'}],
    Saturday:  [{e:'Treadmill Run',s:1,r:'3km',w:'bodyweight'},{e:'Jump Rope',s:4,r:'2m',w:'bodyweight'},{e:'HIIT Circuit',s:1,r:'20m',w:'bodyweight'}],
  },
  teenFemale: {
    Monday:    [{e:'HIIT Circuit',s:1,r:'30m',w:'bodyweight'},{e:'Jump Rope',s:3,r:'3m',w:'bodyweight'},{e:'Stationary Bike',s:1,r:'20m',w:'bodyweight'}],
    Wednesday: [{e:'Pilates',s:1,r:'45m',w:'bodyweight'},{e:'Hanging Leg Raise',s:3,r:'15',w:'bodyweight'},{e:'Russian Twist',s:3,r:'20',w:'6kg'},{e:'Plank',s:3,r:'45s',w:'bodyweight'}],
    Friday:    [{e:'Lat Pulldown',s:3,r:'12',w:'30kg'},{e:'Romanian Deadlift',s:3,r:'12',w:'30kg'},{e:'Leg Press',s:3,r:'15',w:'60kg'},{e:'Yoga Flow',s:1,r:'20m',w:'bodyweight'}],
  },
};

async function seedGym(users) {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const u of users) {
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(u.username);
    const isFemale  = (u.gender||'').toLowerCase()==='female';
    const key = !childHint && !isFemale ? 'adultMale'
              : !childHint &&  isFemale ? 'adultFemale'
              :  childHint && !isFemale ? 'teenMale'
              : 'teenFemale';
    const routines = GYM_ROUTINES[key];

    for (const [y,m] of months) {
      const maxDay = m===5 ? 21 : daysInMonth(y,m);
      for (let day=1; day<=maxDay; day++) {
        const ds  = dt(y,m,day);
        const dow = dayOfWeek(ds);
        if (!routines[dow]) continue;
        for (const ex of routines[dow]) {
          await post('/api/gymworkout', {
            user: u.username, day: dow,
            exercise: ex.e, sets: ex.s, reps: ex.r, weight: ex.w,
            date: ds,
          });
        }
      }
    }
    console.log(`  gym done: ${u.username}`);
  }
}

// ── MEALS ─────────────────────────────────────────────────────────────────────
const MEAL_DATA = {
  adultMale: {
    breakfast: ['Scrambled Eggs on Rye Toast:480','Oats with Berries & Honey:420','Greek Yogurt Parfait:350','Protein Pancakes:460','Oats with Berries & Honey:420','Scrambled Eggs on Rye Toast:480','Overnight Oats & Banana:390'],
    lunch:     ['Grilled Chicken Rice Bowl:620','Tuna Salad Wrap:520','Steak & Rocket Salad:560','Quinoa Power Bowl:480','Grilled Chicken Rice Bowl:620','Tuna Salad Wrap:520','Steak & Rocket Salad:560'],
    dinner:    ['Grilled Salmon & Roasted Veg:600','Chicken Stir-fry & Brown Rice:650','Lamb Chops & Sweet Potato:780','Sirloin Steak & Asparagus:720','Grilled Salmon & Roasted Veg:600','Pasta Bolognese:720','Chicken Stir-fry & Brown Rice:650'],
    snack:     ['Whey Protein Shake:220','Mixed Nuts:180','Whey Protein Shake:220','Apple & Peanut Butter:210','Whey Protein Shake:220','Protein Bar:240','Mixed Nuts:180'],
  },
  adultFemale: {
    breakfast: ['Açaí Smoothie Bowl:380','Avocado Toast & Poached Egg:410','Greek Yogurt Parfait:350','Overnight Oats & Banana:390','Açaí Smoothie Bowl:380','Avocado Toast & Poached Egg:410','Greek Yogurt Parfait:350'],
    lunch:     ['Grilled Chicken Salad:420','Quinoa Power Bowl:480','Greek Salad & Grilled Chicken:440','Turkey & Avocado Sandwich:490','Grilled Chicken Salad:420','Quinoa Power Bowl:480','Sushi Bowl:460'],
    dinner:    ['Grilled Salmon & Roasted Veg:600','Chicken Stir-fry & Brown Rice:650','Prawn Linguine:680','Grilled Salmon & Roasted Veg:600','Prawn Linguine:680','Chicken Stir-fry & Brown Rice:650','Grilled Salmon & Roasted Veg:600'],
    snack:     ['Apple & Peanut Butter:210','Mixed Berries:110','Protein Bar:240','Rice Cakes & Hummus:190','Mixed Berries:110','Apple & Peanut Butter:210','Protein Bar:240'],
  },
  teenMale: {
    breakfast: ['Scrambled Eggs on Rye Toast:480','Cereal with Full Cream Milk:380','Peanut Butter Toast:420','Scrambled Eggs on Rye Toast:480','Cereal with Full Cream Milk:380','Oats with Berries & Honey:420','Peanut Butter Toast:420'],
    lunch:     ['Chicken Sub Roll:580','Mac & Cheese:620','Cheeseburger & Fries:780','Chicken Sub Roll:580','Mac & Cheese:620','Cheeseburger & Fries:780','Chicken Sub Roll:580'],
    dinner:    ['Pasta Bolognese:720','Chicken Schnitzel & Salad:650','Cheeseburger & Fries:780','Pasta Bolognese:720','Chicken Schnitzel & Salad:650','Pasta Bolognese:720','Chicken Stir-fry & Brown Rice:650'],
    snack:     ['Chocolate Milk:200','Chips & Dip:350','Protein Bar:240','Chocolate Milk:200','Chips & Dip:350','Mixed Nuts:180','Chocolate Milk:200'],
  },
  teenFemale: {
    breakfast: ['Açaí Smoothie Bowl:380','Greek Yogurt Parfait:350','Overnight Oats & Banana:390','Avocado Toast & Poached Egg:410','Açaí Smoothie Bowl:380','Overnight Oats & Banana:390','Greek Yogurt Parfait:350'],
    lunch:     ['Chicken Caesar Wrap:480','Sushi Bowl:460','Turkey & Avocado Sandwich:490','Quinoa Power Bowl:480','Chicken Caesar Wrap:480','Sushi Bowl:460','Turkey & Avocado Sandwich:490'],
    dinner:    ['Grilled Salmon & Roasted Veg:600','Chicken Stir-fry & Brown Rice:650','Prawn Linguine:680','Grilled Chicken Salad:420','Grilled Salmon & Roasted Veg:600','Pasta Bolognese:720','Chicken Stir-fry & Brown Rice:650'],
    snack:     ['Mixed Berries:110','Rice Cakes & Hummus:190','Whey Protein Shake:220','Mixed Berries:110','Apple & Peanut Butter:210','Rice Cakes & Hummus:190','Whey Protein Shake:220'],
  },
};

async function seedMeals(users) {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const u of users) {
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(u.username);
    const isFemale  = (u.gender||'').toLowerCase()==='female';
    const key = !childHint && !isFemale ? 'adultMale'
              : !childHint &&  isFemale ? 'adultFemale'
              :  childHint && !isFemale ? 'teenMale'
              : 'teenFemale';
    const plan = MEAL_DATA[key];

    for (const [y,m] of months) {
      const maxDay = m===5 ? 21 : daysInMonth(y,m);
      for (let day=1; day<=maxDay; day++) {
        const ds  = dt(y,m,day);
        const dow = dayOfWeek(ds);
        const di  = DAYS.indexOf(dow);
        const mealTypes = ['breakfast','lunch','dinner'];
        if (day % 3 !== 0) mealTypes.push('snack');
        for (const mt of mealTypes) {
          const foods = plan[mt];
          const [name, calStr] = foods[di % foods.length].split(':');
          await post('/api/mealplan', {
            user: u.username, day: dow, mealType: mt,
            description: name, calories: parseInt(calStr), date: ds,
          });
        }
      }
    }
    console.log(`  meals done: ${u.username}`);
  }
}

// ── PERIOD ────────────────────────────────────────────────────────────────────
const SARAH_CYCLES = [
  {start:'2025-12-03',end:'2025-12-08',len:28,symp:'Cramps,Fatigue'},
  {start:'2025-12-31',end:'2026-01-05',len:28,symp:'Cramps,Bloating'},
  {start:'2026-01-28',end:'2026-02-02',len:29,symp:'Fatigue,Mood swings'},
  {start:'2026-02-26',end:'2026-03-02',len:27,symp:'Cramps'},
  {start:'2026-03-25',end:'2026-03-30',len:28,symp:'Headache,Fatigue'},
  {start:'2026-04-22',end:'2026-04-27',len:28,symp:'Cramps,Bloating'},
  {start:'2026-05-20',end:'2026-05-25',len:28,symp:'Cramps,Fatigue'},
];
const EMMA_CYCLES = [
  {start:'2025-12-05',end:'2025-12-09',len:25,symp:'Nausea,Cramps'},
  {start:'2025-12-30',end:'2026-01-03',len:25,symp:'Cramps,Fatigue'},
  {start:'2026-01-24',end:'2026-01-28',len:25,symp:'Bloating,Mood swings'},
  {start:'2026-02-18',end:'2026-02-22',len:26,symp:'Cramps'},
  {start:'2026-03-16',end:'2026-03-20',len:25,symp:'Fatigue,Nausea'},
  {start:'2026-04-10',end:'2026-04-14',len:25,symp:'Cramps,Headache'},
  {start:'2026-05-05',end:'2026-05-09',len:25,symp:'Cramps,Bloating'},
];

async function seedPeriod(users) {
  for (const u of users) {
    const isFemale = (u.gender||'').toLowerCase()==='female';
    if (!isFemale) continue;
    const childHint = /kid|son|daughter|boy|girl|liam|emma/i.test(u.username);
    const cycles = childHint ? EMMA_CYCLES : SARAH_CYCLES;
    for (const c of cycles) {
      await post('/api/period', {
        user: u.username, startDate: c.start, endDate: c.end,
        cycleLength: c.len, symptoms: c.symp, date: c.start,
      });
    }
    console.log(`  period done: ${u.username}`);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nSeeding → ${BASE}`);
  console.log(`Admin   → ${ADMIN}\n`);

  // 1. Login to verify credentials
  const login = await post('/api/login', {username: ADMIN, password: PASS});
  if (!login.success) {
    console.error('Login failed:', login.message);
    process.exit(1);
  }
  if (!login.isAdmin) {
    console.error(`User "${ADMIN}" is not an admin. Please use an admin account.`);
    process.exit(1);
  }
  console.log(`Logged in as ${login.displayName || ADMIN} ✓\n`);

  // 2. Fetch all users
  const usersRes = await get(`/api/users?adminUsername=${ADMIN}`);
  const users = usersRes.users || usersRes.data;
  if (!usersRes.success || !Array.isArray(users)) {
    console.error('Could not fetch users:', usersRes.message || usersRes);
    process.exit(1);
  }
  console.log(`Found ${users.length} users: ${users.map(u=>u.username).join(', ')}\n`);

  // 3. Get full profile for each user (includes gender + eventColor)
  const fullUsers = [];
  for (const u of users) {
    const p = await get(`/api/profile-pictures?username=${u.username}`);
    fullUsers.push(p.success ? {...u, ...p} : u);
  }

  // 4. Clear existing data
  await clearData(fullUsers);
  console.log('');

  // 5. Seed everything
  console.log('Seeding financial...');
  await seedFinancial(fullUsers);
  console.log('\nSeeding budget...');
  await seedBudget(fullUsers);
  console.log('\nSeeding calendar...');
  await seedCalendar(fullUsers);
  console.log('\nSeeding gym...');
  await seedGym(fullUsers);
  console.log('\nSeeding meals...');
  await seedMeals(fullUsers);
  console.log('\nSeeding period data...');
  await seedPeriod(fullUsers);

  console.log('\n✓ All done!\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
