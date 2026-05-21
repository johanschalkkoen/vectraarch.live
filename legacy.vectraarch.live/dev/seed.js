'use strict';
const { Pool } = require('/home/user/vectraarch.live/legacy.vectraarch.live/node_modules/pg');
const bcrypt   = require('/home/user/vectraarch.live/legacy.vectraarch.live/node_modules/bcrypt');

const pool = new Pool({
  user: 'VectraArchLegacy', host: 'localhost',
  database: 'VectraArchLegacy', password: 'QleCdSsWQqVs3kBP', port: 5432,
});

const run  = (sql, p=[]) => pool.query(sql, p);
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── date helpers ─────────────────────────────────────────────────────────────
function d(y, m, day) {
  const dt = new Date(y, m-1, day);
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function dayOfWeek(dateStr) {
  return DAYS[new Date(dateStr + 'T12:00:00').getDay()];
}
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

// ── SCHEMA ───────────────────────────────────────────────────────────────────
async function createSchema() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_users (
      username TEXT PRIMARY KEY, password_hash TEXT, first_name TEXT, last_name TEXT,
      display_name TEXT, bio TEXT, pronouns TEXT, profile_pic_url TEXT, email TEXT,
      phone TEXT, address TEXT, event_color TEXT DEFAULT '#2dd4bf', is_admin INT DEFAULT 0,
      gender TEXT, telegram_chat_id TEXT, theme TEXT DEFAULT 'dark',
      activity_status INT DEFAULT 0, last_active TIMESTAMP, twofa_secret TEXT)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_access (
      id SERIAL PRIMARY KEY, viewer TEXT, target TEXT, UNIQUE(viewer,target))`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_notifications (
      id SERIAL PRIMARY KEY, username TEXT, type TEXT, enabled INT DEFAULT 0,
      UNIQUE(username,type))`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_transaction_history (
      id SERIAL PRIMARY KEY, username TEXT, action TEXT, table_name TEXT,
      record_id INT, modified_by TEXT, modified_at TIMESTAMP)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_financial (
      id SERIAL PRIMARY KEY, username TEXT, category TEXT, amount NUMERIC,
      type TEXT, date DATE)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_budget (
      id SERIAL PRIMARY KEY, username TEXT, income NUMERIC, expenses JSONB,
      date DATE, budget_type TEXT DEFAULT 'need')`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_calendar (
      id SERIAL PRIMARY KEY, username TEXT, title TEXT, date TIMESTAMP,
      is_financial INT DEFAULT 0, type TEXT, amount NUMERIC, event_color TEXT)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_gymworkout (
      id SERIAL PRIMARY KEY, username TEXT, day TEXT, exercise TEXT,
      sets INT, reps TEXT, weight TEXT, date DATE)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_mealplan (
      id SERIAL PRIMARY KEY, username TEXT, day TEXT, meal_type TEXT,
      description TEXT, calories INT, date DATE)`,

    `CREATE TABLE IF NOT EXISTS vectraarchlegacy_period (
      id SERIAL PRIMARY KEY, username TEXT, start_date DATE, end_date DATE,
      cycle_length INT, symptoms TEXT, date DATE)`,

    `CREATE TABLE IF NOT EXISTS legacy_gym_options (
      id SERIAL PRIMARY KEY, category TEXT, exercise_value TEXT, exercise_label TEXT)`,

    `CREATE TABLE IF NOT EXISTS legacy_meal_templates (
      id SERIAL PRIMARY KEY, category TEXT, meal_value TEXT, meal_label TEXT, calories INT)`,
  ];
  for (const sql of tables) await run(sql);
  console.log('Schema ready.');
}

// ── CLEAR DATA (keep users) ──────────────────────────────────────────────────
async function clearData() {
  const tables = [
    'vectraarchlegacy_transaction_history','vectraarchlegacy_financial',
    'vectraarchlegacy_budget','vectraarchlegacy_calendar',
    'vectraarchlegacy_gymworkout','vectraarchlegacy_mealplan',
    'vectraarchlegacy_period','vectraarchlegacy_access',
    'legacy_gym_options','legacy_meal_templates',
  ];
  for (const t of tables) await run(`DELETE FROM ${t}`);
  await run(`DELETE FROM vectraarchlegacy_users`);
  console.log('Cleared all data.');
}

// ── USERS ────────────────────────────────────────────────────────────────────
const USERS = [
  { username:'johank', password:'koen2026', firstName:'Johan',   lastName:'Koen',
    displayName:'Johan Koen', gender:'Male',   eventColor:'#6a8aff', isAdmin:1,
    email:'johan@koenfamily.co.za',  phone:'+27 82 111 2233', bio:'Dad. Husband. Builder.' },
  { username:'sarahk', password:'koen2026', firstName:'Sarah',   lastName:'Koen',
    displayName:'Sarah Koen', gender:'Female', eventColor:'#ff6b9d', isAdmin:0,
    email:'sarah@koenfamily.co.za',  phone:'+27 83 444 5566', bio:'Mom. Nurse. Wellness enthusiast.' },
  { username:'liamk',  password:'koen2026', firstName:'Liam',    lastName:'Koen',
    displayName:'Liam Koen',  gender:'Male',   eventColor:'#4ade80', isAdmin:0,
    email:'liam@koenfamily.co.za',   phone:'+27 76 777 8899', bio:'Grade 11. Gamer. Gym rat.' },
  { username:'emmak',  password:'koen2026', firstName:'Emma',    lastName:'Koen',
    displayName:'Emma Koen',  gender:'Female', eventColor:'#2dd4bf', isAdmin:0,
    email:'emma@koenfamily.co.za',   phone:'+27 79 000 1122', bio:'Matric 2026. Dance. Coffee.' },
];

async function seedUsers() {
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await run(
      `INSERT INTO vectraarchlegacy_users
        (username,password_hash,first_name,last_name,display_name,bio,email,phone,
         event_color,is_admin,gender,theme,activity_status,last_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dark',1,$12)
       ON CONFLICT(username) DO UPDATE SET
        first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
        display_name=EXCLUDED.display_name, email=EXCLUDED.email, bio=EXCLUDED.bio,
        event_color=EXCLUDED.event_color, is_admin=EXCLUDED.is_admin, gender=EXCLUDED.gender`,
      [u.username,hash,u.firstName,u.lastName,u.displayName,u.bio,u.email,u.phone,
       u.eventColor,u.isAdmin,u.gender, new Date().toISOString()]
    );
  }
  // all-to-all family access
  const users = USERS.map(u=>u.username);
  for (const v of users) for (const t of users) if (v!==t)
    await run(`INSERT INTO vectraarchlegacy_access(viewer,target) VALUES($1,$2) ON CONFLICT DO NOTHING`,[v,t]);
  console.log('Users + access seeded.');
}

// ── GYM OPTIONS ──────────────────────────────────────────────────────────────
const GYM_OPTIONS = [
  ['Chest',['Bench Press:Flat Barbell Bench Press:bench_press','Incline Bench Press:Incline Barbell Press:incline_press','Decline Bench Press:Decline Press:decline_press','Dumbbell Flyes:Dumbbell Chest Flyes:db_flyes','Cable Crossover:Cable Crossover:cable_cross','Chest Dips:Weighted Chest Dips:chest_dips']],
  ['Back',['Deadlift:Conventional Deadlift:deadlift','Barbell Row:Pendlay Row:barbell_row','Pull-ups:Pull-ups (Weighted):pull_ups','Lat Pulldown:Lat Pulldown Machine:lat_pulldown','Seated Cable Row:Seated Cable Row:cable_row','T-Bar Row:T-Bar Row:tbar_row']],
  ['Legs',['Squat:Barbell Back Squat:squat','Leg Press:Leg Press Machine:leg_press','Romanian Deadlift:Romanian Deadlift:rdl','Leg Curl:Hamstring Curl Machine:leg_curl','Leg Extension:Quad Extension:leg_ext','Calf Raise:Standing Calf Raise:calf_raise']],
  ['Shoulders',['Military Press:Overhead Barbell Press:ohp','Dumbbell Shoulder Press:Seated DB Press:db_shoulder','Lateral Raise:Dumbbell Lateral Raise:lat_raise','Front Raise:Dumbbell Front Raise:front_raise','Face Pull:Cable Face Pull:face_pull','Shrugs:Barbell Shrugs:shrugs']],
  ['Arms',['Barbell Curl:Standing Barbell Curl:bb_curl','Dumbbell Curl:Alternating DB Curl:db_curl','Hammer Curl:Neutral Grip Hammer Curl:hammer_curl','Tricep Pushdown:Cable Pushdown:tri_pushdown','Skull Crushers:EZ Bar Skull Crushers:skulls','Tricep Dips:Bodyweight Tricep Dips:tri_dips']],
  ['Cardio',['Treadmill Run:Treadmill Running:treadmill','Cycling:Stationary Bike:cycling','HIIT:HIIT Circuit:hiit','Jump Rope:Jump Rope Intervals:jump_rope','Rowing Machine:Rowing Ergometer:rowing','Stairmaster:Stairmaster Cardio:stairmaster']],
  ['Core',['Plank:Standard Plank:plank','Crunches:Weighted Crunches:crunches','Russian Twist:Dumbbell Russian Twist:russian_twist','Leg Raise:Hanging Leg Raise:leg_raise','Ab Wheel:Ab Wheel Rollout:ab_wheel','Cable Crunch:Cable Crunch:cable_crunch']],
  ['Flexibility',['Yoga Flow:Full Body Yoga Flow:yoga','Pilates:Pilates Mat Work:pilates','Foam Rolling:Full Body Foam Roll:foam_roll','Hip Flexor Stretch:Hip Flexor + Glute Stretch:hip_stretch','Shoulder Mobility:Shoulder Mobility Drill:shoulder_mob','Hamstring Stretch:Standing Hamstring Stretch:ham_stretch']],
];

async function seedGymOptions() {
  for (const [cat, exercises] of GYM_OPTIONS) {
    for (const ex of exercises) {
      const [val, label] = ex.split(':');
      await run(`INSERT INTO legacy_gym_options(category,exercise_value,exercise_label) VALUES($1,$2,$3)`,[cat,val,label]);
    }
  }
}

// ── MEAL TEMPLATES ────────────────────────────────────────────────────────────
const MEAL_TEMPLATES = [
  ['Breakfast:High Protein','eggs_toast:Scrambled Eggs on Rye Toast:480','oats_berries:Oats with Berries + Honey:420','greek_parfait:Greek Yogurt Parfait:350','smoothie_bowl:Açaí Smoothie Bowl:380','avo_toast:Avocado Toast + Poached Egg:410','protein_pancakes:Protein Pancakes:460','overnight_oats:Overnight Oats + Banana:390'],
  ['Lunch:Balanced','chicken_bowl:Grilled Chicken Rice Bowl:620','tuna_wrap:Tuna Salad Wrap:520','quinoa_bowl:Quinoa Power Bowl:480','beef_salad:Steak + Rocket Salad:560','greek_salad:Greek Salad + Grilled Chicken:440','turkey_sandwich:Turkey & Avocado Sandwich:490','sushi_bowl:Sushi Bowl:460'],
  ['Dinner:High Protein','salmon_veg:Grilled Salmon + Roasted Veg:600','chicken_stirfry:Chicken Stir-fry + Brown Rice:650','lamb_chops:Lamb Chops + Sweet Potato:780','beef_steak:Sirloin + Asparagus:720','prawn_pasta:Prawn Linguine:680','chicken_schnitzel:Chicken Schnitzel + Salad:650','pasta_bol:Pasta Bolognese:720'],
  ['Snack:Light','protein_shake:Whey Protein Shake:220','mixed_nuts:Mixed Nuts:180','apple_pb:Apple + Peanut Butter:210','protein_bar:Protein Bar:240','rice_cakes:Rice Cakes + Hummus:190','berries:Mixed Berries:110','choc_milk:Chocolate Milk:200'],
  ['Cheat Meal:Occasional','burger_fries:Cheeseburger + Fries:950','pizza_slice:Pizza x2 Slices:780','mac_cheese:Mac & Cheese:720','fish_chips:Fish & Chips:820','hot_dog:Hot Dog + Chips:680','waffle:Belgian Waffle + Ice Cream:620','milkshake:Thick Milkshake:550'],
];

async function seedMealTemplates() {
  for (const row of MEAL_TEMPLATES) {
    const [catRaw, ...meals] = row;
    const [cat] = catRaw.split(':');
    for (const m of meals) {
      const parts = m.split(':');
      await run(`INSERT INTO legacy_meal_templates(category,meal_value,meal_label,calories) VALUES($1,$2,$3,$4)`,
        [cat, parts[0], parts[1], parseInt(parts[2])]);
    }
  }
}

// ── FINANCIAL ────────────────────────────────────────────────────────────────
// Monthly financial patterns per user
function johanMonthlyFinancial(y, m) {
  const rows = [];
  const freelance = [8500,12000,6500,14000,9000][m%5];
  rows.push({category:'Salary',               amount:55000, type:'income',  day:25});
  rows.push({category:'Freelance Consulting',  amount:freelance, type:'income',  day:3});
  rows.push({category:'Investment Dividend',   amount:2800,  type:'income',  day:15});
  rows.push({category:'Mortgage',              amount:15200, type:'expense', day:1});
  rows.push({category:'Car Payment – BMW',     amount:5480,  type:'expense', day:3});
  rows.push({category:'Car Insurance',         amount:1850,  type:'expense', day:3});
  rows.push({category:'Medical Aid',           amount:4200,  type:'expense', day:5});
  rows.push({category:'School Fees',           amount:4800,  type:'expense', day:7});
  rows.push({category:'Life Insurance',        amount:980,   type:'expense', day:5});
  rows.push({category:'Rates & Taxes',         amount:1650,  type:'expense', day:10});
  rows.push({category:'Electricity',           amount:1100,  type:'expense', day:12});
  rows.push({category:'Internet & Fibre',      amount:699,   type:'expense', day:4});
  rows.push({category:'Groceries – Pick n Pay',amount:3800,  type:'expense', day:8});
  rows.push({category:'Groceries – Woolworths',amount:1200,  type:'expense', day:20});
  rows.push({category:'Fuel',                  amount:[1600,1750,1900,1680,1720][m%5], type:'expense', day:10});
  rows.push({category:'Fuel',                  amount:[800,900,1100,750,850][m%5],  type:'expense', day:22});
  rows.push({category:'Gym Membership',        amount:950,   type:'expense', day:1});
  rows.push({category:'Dining Out',            amount:[2100,1850,2400,1950,2200][m%5], type:'expense', day:18});
  rows.push({category:'Entertainment',         amount:[800,1200,600,900,750][m%5], type:'expense', day:21});
  rows.push({category:'Clothing',              amount:[1500,0,2200,0,1800][m%5],    type:'expense', day:16});
  rows.push({category:'Home Maintenance',      amount:[0,2500,0,1800,0][m%5],       type:'expense', day:14});
  rows.push({category:'Savings Transfer',      amount:8000,  type:'expense', day:26});
  return rows.filter(r=>r.amount>0);
}

function sarahMonthlyFinancial(y, m) {
  const rows = [];
  const consult = [9000,0,11500,0,8500][m%5];
  rows.push({category:'Salary',               amount:38000, type:'income',  day:25});
  if (consult) rows.push({category:'Consulting Fee', amount:consult, type:'income', day:12});
  rows.push({category:'Car Payment – VW',      amount:4200,  type:'expense', day:3});
  rows.push({category:'Car Insurance',         amount:1250,  type:'expense', day:3});
  rows.push({category:'Gym & Pilates Studio',  amount:650,   type:'expense', day:1});
  rows.push({category:'Clothing',              amount:[2800,1500,3200,1800,2200][m%5], type:'expense', day:14});
  rows.push({category:'Personal Care & Beauty',amount:[1400,1800,1200,1600,1500][m%5], type:'expense', day:18});
  rows.push({category:'Groceries',             amount:2500,  type:'expense', day:9});
  rows.push({category:'Dining Out',            amount:[1200,900,1500,1100,1300][m%5], type:'expense', day:20});
  rows.push({category:'Pharmacy',              amount:[350,600,280,400,320][m%5],  type:'expense', day:15});
  rows.push({category:'Streaming Services',    amount:280,   type:'expense', day:4});
  rows.push({category:'Savings',               amount:5000,  type:'expense', day:26});
  rows.push({category:'Kids Activities',       amount:[1200,0,1500,800,1000][m%5],  type:'expense', day:8});
  return rows.filter(r=>r.amount>0);
}

function liamMonthlyFinancial(y, m) {
  const rows = [];
  rows.push({category:'Monthly Allowance',     amount:2000,  type:'income',  day:1});
  rows.push({category:'Gaming',                amount:[800,1200,600,950,700][m%5], type:'expense', day:10});
  rows.push({category:'Snacks & Tuck Shop',    amount:[320,280,350,300,260][m%5],  type:'expense', day:15});
  rows.push({category:'Clothing',              amount:[0,500,0,800,0][m%5],         type:'expense', day:20});
  rows.push({category:'School Supplies',       amount:[250,0,350,0,180][m%5],       type:'expense', day:5});
  rows.push({category:'Airtime & Data',        amount:200,   type:'expense', day:3});
  return rows.filter(r=>r.amount>0);
}

function emmaMonthlyFinancial(y, m) {
  const rows = [];
  rows.push({category:'Monthly Allowance',     amount:1800,  type:'income',  day:1});
  rows.push({category:'Part-time: Barista',    amount:[3500,3200,3800,3400,3600][m%5], type:'income', day:28});
  rows.push({category:'Beauty & Nails',        amount:[680,900,560,780,720][m%5],   type:'expense', day:16});
  rows.push({category:'Clothing & Fashion',    amount:[1200,800,1500,900,1100][m%5],type:'expense', day:18});
  rows.push({category:'Coffee & Cafes',        amount:[420,380,460,350,400][m%5],   type:'expense', day:20});
  rows.push({category:'Streaming & Digital',   amount:280,   type:'expense', day:4});
  rows.push({category:'Dance Classes',         amount:650,   type:'expense', day:2});
  rows.push({category:'Airtime & Data',        amount:200,   type:'expense', day:3});
  rows.push({category:'Books & Study',         amount:[150,0,280,0,200][m%5],       type:'expense', day:8});
  rows.push({category:'Savings',               amount:1000,  type:'expense', day:28});
  return rows.filter(r=>r.amount>0);
}

async function seedFinancial() {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  const generators = {
    johank: johanMonthlyFinancial,
    sarahk: sarahMonthlyFinancial,
    liamk:  liamMonthlyFinancial,
    emmak:  emmaMonthlyFinancial,
  };
  for (const [y,m] of months) {
    const maxDay = m === 5 ? 21 : daysInMonth(y,m); // don't go past today in May
    for (const [user, gen] of Object.entries(generators)) {
      const rows = gen(y, m);
      for (const r of rows) {
        const day = Math.min(r.day, maxDay);
        const dateStr = d(y, m, day);
        await run(
          `INSERT INTO vectraarchlegacy_financial(username,category,amount,type,date) VALUES($1,$2,$3,$4,$5)`,
          [user, r.category, r.amount, r.type, dateStr]
        );
        // mirror as calendar entry
        const title = r.type==='income'
          ? `${r.category} +R${r.amount.toLocaleString()}`
          : `${r.category} -R${r.amount.toLocaleString()}`;
        const color = generators[user] === johanMonthlyFinancial ? '#6a8aff'
          : generators[user] === sarahMonthlyFinancial ? '#ff6b9d'
          : generators[user] === liamMonthlyFinancial ? '#4ade80' : '#2dd4bf';
        await run(
          `INSERT INTO vectraarchlegacy_calendar(username,title,date,is_financial,type,amount,event_color)
           VALUES($1,$2,$3,1,$4,$5,$6)`,
          [user, title, dateStr + ' 09:00:00', r.type, r.amount, color]
        );
      }
    }
  }
  console.log('Financial seeded.');
}

// ── BUDGET ───────────────────────────────────────────────────────────────────
async function seedBudget() {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];

  const budgets = {
    johank: (y,m)=>({
      income: 55000 + [8500,12000,6500,14000,9000][m%5] + 2800,
      expenses: [
        {description:'Mortgage',          amount:15200},
        {description:'Car Payments',      amount:5480},
        {description:'Insurance',         amount:1850+980},
        {description:'Medical Aid',       amount:4200},
        {description:'School Fees',       amount:4800},
        {description:'Utilities & Rates', amount:1650+1100+699},
        {description:'Groceries',         amount:5000},
        {description:'Fuel',              amount:[2400,2650,3000,2430,2570][m%5]},
        {description:'Gym',               amount:950},
        {description:'Dining & Entertainment', amount:[2900,3050,3000,2850,2950][m%5]},
        {description:'Savings',           amount:8000},
      ],
    }),
    sarahk: (y,m)=>({
      income: 38000 + [9000,0,11500,0,8500][m%5],
      expenses: [
        {description:'Car Payment',       amount:4200},
        {description:'Car Insurance',     amount:1250},
        {description:'Gym & Pilates',     amount:650},
        {description:'Clothing & Beauty', amount:[4200,3300,4400,3400,3700][m%5]},
        {description:'Groceries',         amount:2500},
        {description:'Dining Out',        amount:[1200,900,1500,1100,1300][m%5]},
        {description:'Kids Activities',   amount:[1200,0,1500,800,1000][m%5]},
        {description:'Savings',           amount:5000},
      ].filter(e=>e.amount>0),
    }),
    liamk: (y,m)=>({
      income: 2000,
      expenses: [
        {description:'Gaming',            amount:[800,1200,600,950,700][m%5]},
        {description:'Snacks',            amount:[320,280,350,300,260][m%5]},
        {description:'Airtime',           amount:200},
      ],
    }),
    emmak: (y,m)=>({
      income: 1800 + [3500,3200,3800,3400,3600][m%5],
      expenses: [
        {description:'Beauty & Fashion',  amount:[1880,1700,2060,1680,1820][m%5]},
        {description:'Coffee & Cafes',    amount:[420,380,460,350,400][m%5]},
        {description:'Dance Classes',     amount:650},
        {description:'Streaming',         amount:280},
        {description:'Savings',           amount:1000},
      ],
    }),
  };

  for (const [y,m] of months) {
    const dateStr = d(y, m, 1);
    for (const [user, gen] of Object.entries(budgets)) {
      const {income, expenses} = gen(y,m);
      await run(
        `INSERT INTO vectraarchlegacy_budget(username,income,expenses,date,budget_type) VALUES($1,$2,$3,$4,'need')`,
        [user, income, JSON.stringify(expenses), dateStr]
      );
    }
  }
  console.log('Budget seeded.');
}

// ── CALENDAR EVENTS ───────────────────────────────────────────────────────────
async function seedCalendar() {
  const events = [
    // Johan
    {u:'johank', title:'Team Standup', dates:['2026-01-06','2026-01-13','2026-01-20','2026-01-27','2026-02-03','2026-02-10','2026-02-17','2026-02-24','2026-03-03','2026-03-10','2026-03-17','2026-03-24','2026-03-31','2026-04-07','2026-04-14','2026-04-22','2026-04-28','2026-05-05','2026-05-12','2026-05-19'], time:'08:30:00', color:'#6a8aff'},
    {u:'johank', title:'Client Presentation', dates:['2026-01-15','2026-02-19','2026-03-26','2026-04-30','2026-05-14'], time:'10:00:00', color:'#6a8aff'},
    {u:'johank', title:'Project Deadline', dates:['2026-01-31','2026-02-28','2026-03-31','2026-04-30','2026-05-21'], time:'17:00:00', color:'#ff4d4d'},
    {u:'johank', title:"Sarah's Birthday", dates:['2026-03-12'], time:'00:00:00', color:'#ff6b9d'},
    {u:'johank', title:"Liam's Rugby Match", dates:['2026-02-07','2026-03-07','2026-04-04'], time:'10:00:00', color:'#4ade80'},
    {u:'johank', title:'Car Service', dates:['2026-02-14'], time:'09:00:00', color:'#ffd600'},
    {u:'johank', title:'Dentist Appointment', dates:['2026-04-16'], time:'14:00:00', color:'#ffd600'},
    {u:'johank', title:'Family Braai', dates:['2026-01-18','2026-02-22','2026-04-12','2026-05-10'], time:'12:00:00', color:'#ff9800'},
    // Sarah
    {u:'sarahk', title:'Hospital Shift', dates:['2026-01-07','2026-01-08','2026-01-14','2026-01-15','2026-02-04','2026-02-05','2026-02-11','2026-03-04','2026-03-05','2026-03-11','2026-04-01','2026-04-02','2026-04-08','2026-05-06','2026-05-07','2026-05-13'], time:'07:00:00', color:'#ff6b9d'},
    {u:'sarahk', title:'Pilates Class', dates:['2026-01-05','2026-01-12','2026-01-19','2026-01-26','2026-02-02','2026-02-09','2026-02-16','2026-02-23','2026-03-02','2026-03-09','2026-03-16','2026-03-23','2026-03-30','2026-04-06','2026-04-13','2026-04-20','2026-04-27','2026-05-04','2026-05-11','2026-05-18'], time:'06:30:00', color:'#ff6b9d'},
    {u:'sarahk', title:"Liam's Parent-Teacher", dates:['2026-02-26','2026-05-07'], time:'15:30:00', color:'#4ade80'},
    {u:'sarahk', title:'Gynae Appointment', dates:['2026-03-18'], time:'10:00:00', color:'#ff6b9d'},
    {u:'sarahk', title:'Girls Night Out', dates:['2026-01-24','2026-03-28','2026-05-16'], time:'19:00:00', color:'#b06aff'},
    {u:'sarahk', title:'Meal Prep Sunday', dates:['2026-01-11','2026-01-25','2026-02-08','2026-02-22','2026-03-08','2026-03-22','2026-04-05','2026-04-19','2026-05-03','2026-05-17'], time:'10:00:00', color:'#ff6b9d'},
    // Liam
    {u:'liamk', title:'School – Exam', dates:['2026-01-28','2026-01-29','2026-01-30','2026-06-08','2026-06-09'], time:'08:00:00', color:'#ff4d4d'},
    {u:'liamk', title:'Rugby Practice', dates:['2026-01-06','2026-01-08','2026-01-13','2026-01-15','2026-01-20','2026-01-22','2026-01-27','2026-01-29','2026-02-03','2026-02-05','2026-02-10','2026-02-12','2026-02-17','2026-02-19','2026-02-24','2026-02-26','2026-03-03','2026-03-05','2026-03-10','2026-03-12','2026-03-17','2026-03-19','2026-03-24','2026-03-26','2026-04-02','2026-04-07','2026-04-09','2026-04-14','2026-04-21','2026-04-23','2026-04-28','2026-04-30','2026-05-05','2026-05-07','2026-05-12','2026-05-14','2026-05-19','2026-05-21'], time:'15:30:00', color:'#4ade80'},
    {u:'liamk', title:'Gaming Session – Friends', dates:['2026-01-10','2026-01-17','2026-01-24','2026-01-31','2026-02-07','2026-02-14','2026-02-21','2026-02-28','2026-03-07','2026-03-14','2026-03-21','2026-03-28','2026-04-04','2026-04-11','2026-04-18','2026-04-25','2026-05-02','2026-05-09','2026-05-16'], time:'18:00:00', color:'#4ade80'},
    // Emma
    {u:'emmak', title:'Dance Rehearsal', dates:['2026-01-05','2026-01-07','2026-01-12','2026-01-14','2026-01-19','2026-01-21','2026-01-26','2026-01-28','2026-02-02','2026-02-04','2026-02-09','2026-02-11','2026-02-16','2026-02-18','2026-02-23','2026-02-25','2026-03-02','2026-03-04','2026-03-09','2026-03-11','2026-03-16','2026-03-18','2026-03-23','2026-03-25','2026-03-30','2026-04-01','2026-04-06','2026-04-08','2026-04-13','2026-04-15','2026-04-20','2026-04-22','2026-04-27','2026-04-29','2026-05-04','2026-05-06','2026-05-11','2026-05-13','2026-05-18','2026-05-20'], time:'16:00:00', color:'#2dd4bf'},
    {u:'emmak', title:'Coffee with Friends', dates:['2026-01-10','2026-01-17','2026-01-24','2026-01-31','2026-02-07','2026-02-14','2026-02-21','2026-02-28','2026-03-07','2026-03-14','2026-03-21','2026-03-28','2026-04-04','2026-04-11','2026-04-18','2026-04-25','2026-05-02','2026-05-09','2026-05-16'], time:'11:00:00', color:'#2dd4bf'},
    {u:'emmak', title:'Work Shift – Café', dates:['2026-01-06','2026-01-08','2026-01-13','2026-01-15','2026-01-20','2026-01-22','2026-01-27','2026-01-29','2026-02-03','2026-02-05','2026-02-10','2026-02-12','2026-02-17','2026-02-19','2026-02-24','2026-02-26','2026-03-03','2026-03-05','2026-03-10','2026-03-12','2026-03-17','2026-03-19','2026-03-24','2026-03-26','2026-03-31','2026-04-02','2026-04-07','2026-04-09','2026-04-14','2026-04-16','2026-04-21','2026-04-23','2026-04-28','2026-04-30','2026-05-05','2026-05-07','2026-05-12','2026-05-14','2026-05-19','2026-05-21'], time:'07:00:00', color:'#2dd4bf'},
    {u:'emmak', title:'Gynaecology Check-up', dates:['2026-02-10','2026-05-12'], time:'10:00:00', color:'#b06aff'},
    // Family shared events
    {u:'johank', title:'Family Holiday – Hermanus', dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00', color:'#ff9800'},
    {u:'sarahk', title:'Family Holiday – Hermanus', dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00', color:'#ff9800'},
    {u:'liamk',  title:'Family Holiday – Hermanus', dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00', color:'#4ade80'},
    {u:'emmak',  title:'Family Holiday – Hermanus', dates:['2026-04-18','2026-04-19','2026-04-20'], time:'08:00:00', color:'#2dd4bf'},
    {u:'johank', title:"Dad's Birthday", dates:['2026-01-29'], time:'00:00:00', color:'#6a8aff'},
    {u:'sarahk', title:"Johan's Birthday", dates:['2026-01-29'], time:'00:00:00', color:'#6a8aff'},
    {u:'liamk',  title:"Dad's Birthday", dates:['2026-01-29'], time:'00:00:00', color:'#4ade80'},
    {u:'emmak',  title:"Dad's Birthday", dates:['2026-01-29'], time:'00:00:00', color:'#2dd4bf'},
  ];

  for (const ev of events) {
    for (const dt of ev.dates) {
      await run(
        `INSERT INTO vectraarchlegacy_calendar(username,title,date,is_financial,type,amount,event_color) VALUES($1,$2,$3,0,null,null,$4)`,
        [ev.u, ev.title, `${dt} ${ev.time}`, ev.color]
      );
    }
  }
  console.log('Calendar seeded.');
}

// ── GYM WORKOUTS ─────────────────────────────────────────────────────────────
// Returns array of {exercise, sets, reps, weight} blocks for a given routine
const JOHAN_ROUTINES = {
  Monday:    [{e:'bench_press',s:4,r:'8',w:'100kg'},{e:'incline_press',s:3,r:'10',w:'80kg'},{e:'db_flyes',s:3,r:'12',w:'24kg'},{e:'tri_pushdown',s:4,r:'12',w:'40kg'},{e:'skulls',s:3,r:'10',w:'45kg'}],
  Wednesday: [{e:'deadlift',s:4,r:'5',w:'160kg'},{e:'barbell_row',s:4,r:'8',w:'100kg'},{e:'pull_ups',s:3,r:'8',w:'+20kg'},{e:'lat_pulldown',s:3,r:'12',w:'70kg'},{e:'bb_curl',s:4,r:'10',w:'50kg'}],
  Thursday:  [{e:'squat',s:4,r:'8',w:'140kg'},{e:'leg_press',s:4,r:'12',w:'200kg'},{e:'rdl',s:3,r:'10',w:'100kg'},{e:'leg_curl',s:3,r:'12',w:'50kg'},{e:'calf_raise',s:4,r:'20',w:'80kg'}],
  Saturday:  [{e:'ohp',s:4,r:'8',w:'80kg'},{e:'db_shoulder',s:3,r:'10',w:'30kg'},{e:'lat_raise',s:4,r:'15',w:'12kg'},{e:'face_pull',s:3,r:'15',w:'30kg'},{e:'shrugs',s:3,r:'12',w:'80kg'}],
};
const SARAH_ROUTINES = {
  Monday:    [{e:'yoga',s:1,r:'45m',w:'bodyweight'},{e:'hip_stretch',s:2,r:'30s',w:'bodyweight'},{e:'shoulder_mob',s:2,r:'30s',w:'bodyweight'}],
  Wednesday: [{e:'hiit',s:1,r:'30m',w:'bodyweight'},{e:'jump_rope',s:4,r:'3m',w:'bodyweight'},{e:'burpees',s:3,r:'20',w:'bodyweight'}],
  Friday:    [{e:'lat_pulldown',s:3,r:'12',w:'45kg'},{e:'db_shoulder',s:3,r:'12',w:'10kg'},{e:'rdl',s:3,r:'12',w:'40kg'},{e:'cable_row',s:3,r:'12',w:'40kg'},{e:'plank',s:3,r:'60s',w:'bodyweight'}],
  Sunday:    [{e:'treadmill',s:1,r:'5km',w:'bodyweight'},{e:'cycling',s:1,r:'20m',w:'bodyweight'}],
};
const LIAM_ROUTINES = {
  Tuesday:   [{e:'bench_press',s:3,r:'10',w:'60kg'},{e:'db_curl',s:3,r:'12',w:'16kg'},{e:'pull_ups',s:3,r:'8',w:'bodyweight'},{e:'tri_dips',s:3,r:'12',w:'bodyweight'},{e:'ab_wheel',s:3,r:'15',w:'bodyweight'}],
  Thursday:  [{e:'squat',s:3,r:'10',w:'80kg'},{e:'leg_press',s:3,r:'15',w:'120kg'},{e:'calf_raise',s:4,r:'20',w:'60kg'},{e:'plank',s:3,r:'45s',w:'bodyweight'}],
  Saturday:  [{e:'treadmill',s:1,r:'3km',w:'bodyweight'},{e:'jump_rope',s:4,r:'2m',w:'bodyweight'},{e:'hiit',s:1,r:'20m',w:'bodyweight'}],
};
const EMMA_ROUTINES = {
  Monday:    [{e:'hiit',s:1,r:'30m',w:'bodyweight'},{e:'jump_rope',s:3,r:'3m',w:'bodyweight'},{e:'cycling',s:1,r:'20m',w:'bodyweight'}],
  Wednesday: [{e:'pilates',s:1,r:'45m',w:'bodyweight'},{e:'leg_raise',s:3,r:'15',w:'bodyweight'},{e:'russian_twist',s:3,r:'20',w:'6kg'},{e:'plank',s:3,r:'45s',w:'bodyweight'}],
  Friday:    [{e:'lat_pulldown',s:3,r:'12',w:'30kg'},{e:'rdl',s:3,r:'12',w:'30kg'},{e:'leg_press',s:3,r:'15',w:'60kg'},{e:'yoga',s:1,r:'20m',w:'bodyweight'}],
};

const ROUTINE_MAP = {johank:JOHAN_ROUTINES, sarahk:SARAH_ROUTINES, liamk:LIAM_ROUTINES, emmak:EMMA_ROUTINES};

async function seedGym() {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const [y,m] of months) {
    const maxDay = m===5 ? 21 : daysInMonth(y,m);
    for (const [user, routines] of Object.entries(ROUTINE_MAP)) {
      for (let day=1; day<=maxDay; day++) {
        const dateStr = d(y,m,day);
        const dow = dayOfWeek(dateStr);
        if (!routines[dow]) continue;
        for (const ex of routines[dow]) {
          await run(
            `INSERT INTO vectraarchlegacy_gymworkout(username,day,exercise,sets,reps,weight,date) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [user, dow, ex.e, ex.s, ex.r, ex.w, dateStr]
          );
        }
      }
    }
  }
  console.log('Gym seeded.');
}

// ── MEALS ─────────────────────────────────────────────────────────────────────
const MEAL_PLANS = {
  johank: {
    breakfast: ['eggs_toast','oats_berries','greek_parfait','protein_pancakes','oats_berries','eggs_toast','overnight_oats'],
    lunch:     ['chicken_bowl','tuna_wrap','beef_salad','quinoa_bowl','chicken_bowl','tuna_wrap','beef_salad'],
    dinner:    ['salmon_veg','chicken_stirfry','lamb_chops','beef_steak','salmon_veg','pasta_bol','chicken_stirfry'],
    snack:     ['protein_shake','mixed_nuts','protein_shake','apple_pb','protein_shake','protein_bar','mixed_nuts'],
  },
  sarahk: {
    breakfast: ['smoothie_bowl','avo_toast','greek_parfait','overnight_oats','smoothie_bowl','avo_toast','greek_parfait'],
    lunch:     ['chicken_salad','quinoa_bowl','greek_salad','turkey_sandwich','chicken_salad','quinoa_bowl','sushi_bowl'],
    dinner:    ['salmon_veg','chicken_stirfry','prawn_pasta','salmon_veg','prawn_pasta','chicken_stirfry','salmon_veg'],
    snack:     ['apple_pb','berries','protein_bar','rice_cakes','berries','apple_pb','protein_bar'],
  },
  liamk: {
    breakfast: ['eggs_toast','cereal','pb_toast','eggs_toast','cereal','oats_berries','pb_toast'],
    lunch:     ['chicken_sub','mac_cheese','burger_fries','chicken_sub','mac_cheese','burger_fries','chicken_sub'],
    dinner:    ['pasta_bol','chicken_schnitzel','burger_fries','pasta_bol','chicken_schnitzel','pasta_bol','chicken_stirfry'],
    snack:     ['choc_milk','chips_dip','protein_bar','choc_milk','chips_dip','mixed_nuts','choc_milk'],
  },
  emmak: {
    breakfast: ['smoothie_bowl','greek_parfait','overnight_oats','avo_toast','smoothie_bowl','overnight_oats','greek_parfait'],
    lunch:     ['chicken_wrap','sushi_bowl','turkey_sandwich','quinoa_bowl','chicken_wrap','sushi_bowl','turkey_sandwich'],
    dinner:    ['salmon_veg','chicken_stirfry','prawn_pasta','chicken_salad','salmon_veg','pasta_bol','chicken_stirfry'],
    snack:     ['berries','rice_cakes','protein_shake','berries','apple_pb','rice_cakes','protein_shake'],
  },
};

// Calorie lookup (approximate)
const CAL_MAP = {
  eggs_toast:480, oats_berries:420, greek_parfait:350, protein_pancakes:460,
  overnight_oats:390, smoothie_bowl:380, avo_toast:410, cereal:380, pb_toast:420,
  chicken_bowl:620, tuna_wrap:520, beef_salad:560, quinoa_bowl:480, greek_salad:440,
  turkey_sandwich:490, sushi_bowl:460, chicken_salad:420, chicken_wrap:480,
  chicken_sub:580, mac_cheese:620, burger_fries:780,
  salmon_veg:600, chicken_stirfry:650, lamb_chops:780, beef_steak:720,
  prawn_pasta:680, chicken_schnitzel:650, pasta_bol:720,
  protein_shake:220, mixed_nuts:180, apple_pb:210, protein_bar:240,
  rice_cakes:190, berries:110, choc_milk:200, chips_dip:350,
};

async function seedMeals() {
  const months = [[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]];
  for (const [y,m] of months) {
    const maxDay = m===5 ? 21 : daysInMonth(y,m);
    for (const [user, plan] of Object.entries(MEAL_PLANS)) {
      for (let day=1; day<=maxDay; day++) {
        const dateStr = d(y,m,day);
        const dow = dayOfWeek(dateStr);
        const di = DAYS.indexOf(dow); // 0-6
        const mealTypes = ['breakfast','lunch','dinner'];
        // Add snack on non-rest days (most days)
        const hasSnack = day % 3 !== 0;
        if (hasSnack) mealTypes.push('snack');

        for (const mt of mealTypes) {
          const foods = plan[mt] || plan.snack;
          const foodKey = foods[di % foods.length];
          const cal = CAL_MAP[foodKey] || 400;
          await run(
            `INSERT INTO vectraarchlegacy_mealplan(username,day,meal_type,description,calories,date) VALUES($1,$2,$3,$4,$5,$6)`,
            [user, dow, mt, foodKey, cal, dateStr]
          );
        }
      }
    }
  }
  console.log('Meals seeded.');
}

// ── PERIOD ────────────────────────────────────────────────────────────────────
async function seedPeriod() {
  // Sarah: 28-29 day cycle
  const sarahCycles = [
    {start:'2025-12-03', end:'2025-12-08', len:28, symp:'Cramps,Fatigue'},
    {start:'2025-12-31', end:'2026-01-05', len:28, symp:'Cramps,Bloating'},
    {start:'2026-01-28', end:'2026-02-02', len:29, symp:'Fatigue,Mood swings'},
    {start:'2026-02-26', end:'2026-03-02', len:27, symp:'Cramps'},
    {start:'2026-03-25', end:'2026-03-30', len:28, symp:'Headache,Fatigue'},
    {start:'2026-04-22', end:'2026-04-27', len:28, symp:'Cramps,Bloating'},
    {start:'2026-05-20', end:'2026-05-25', len:28, symp:'Cramps,Fatigue'},
  ];
  // Emma: 25-26 day cycle
  const emmaCycles = [
    {start:'2025-12-05', end:'2025-12-09', len:25, symp:'Nausea,Cramps'},
    {start:'2025-12-30', end:'2026-01-03', len:25, symp:'Cramps,Fatigue'},
    {start:'2026-01-24', end:'2026-01-28', len:25, symp:'Bloating,Mood swings'},
    {start:'2026-02-18', end:'2026-02-22', len:26, symp:'Cramps'},
    {start:'2026-03-16', end:'2026-03-20', len:25, symp:'Fatigue,Nausea'},
    {start:'2026-04-10', end:'2026-04-14', len:25, symp:'Cramps,Headache'},
    {start:'2026-05-05', end:'2026-05-09', len:25, symp:'Cramps,Bloating'},
  ];

  for (const c of sarahCycles) {
    await run(`INSERT INTO vectraarchlegacy_period(username,start_date,end_date,cycle_length,symptoms,date) VALUES($1,$2,$3,$4,$5,$6)`,
      ['sarahk', c.start, c.end, c.len, c.symp, c.start]);
  }
  for (const c of emmaCycles) {
    await run(`INSERT INTO vectraarchlegacy_period(username,start_date,end_date,cycle_length,symptoms,date) VALUES($1,$2,$3,$4,$5,$6)`,
      ['emmak', c.start, c.end, c.len, c.symp, c.start]);
  }
  console.log('Period data seeded.');
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await createSchema();
    await clearData();
    await seedUsers();
    await seedGymOptions();
    await seedMealTemplates();
    await seedFinancial();
    await seedBudget();
    await seedCalendar();
    await seedGym();
    await seedMeals();
    await seedPeriod();
    console.log('\n✓ All done. Database fully seeded.\n');
  } catch(e) {
    console.error('Seed error:', e.message, e.stack);
  } finally {
    pool.end();
  }
}

main();
