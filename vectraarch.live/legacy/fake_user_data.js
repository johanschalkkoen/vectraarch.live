'use strict';

const { Pool } = require('pg');
require('dotenv').config({ path: '/var/www/vectraarch.live/forge/.env' });

const pool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchLegacy',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

async function run() {
  try {
    console.log('1. Verifying existing system users...');
    const targetUsers = ['female', 'male', 'girl', 'boy'];
    const { rows: existing } = await pool.query(
      `SELECT username FROM vectraarchlegacy_users WHERE username = ANY($1)`, 
      [targetUsers]
    );

    const existingNames = existing.map(r => r.username);
    const missing = targetUsers.filter(u => !existingNames.includes(u));

    if (missing.length > 0) {
      throw new Error(`Required users missing from database: ${missing.join(', ')}. Please create them first.`);
    }
    console.log('   All 4 target users verified.');

    console.log('2. Purging existing transactional, schedule, and performance data...');
    await pool.query(`TRUNCATE vectraarchlegacy_financial, vectraarchlegacy_budget, 
      vectraarchlegacy_calendar, vectraarchlegacy_gymworkout, vectraarchlegacy_mealplan, 
      vectraarchlegacy_period CASCADE;`);

    // ════════════════════════════════════════════════════════════
    // 3. BUDGETS
    // ════════════════════════════════════════════════════════════
    console.log('3. Injecting 5 months of household budget setups...');
    const budgets = [];
    const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'];
    
    for (const mo of months) {
      budgets.push(
        { u:'female', type:'need',   cat:'Curro School Fees',       amt:12000, mo },
        { u:'female', type:'need',   cat:'Discovery Medical Aid',   amt:4500,  mo },
        { u:'female', type:'need',   cat:'SuperSpar Groceries',     amt:4000,  mo },
        { u:'female', type:'want',   cat:'Woolworths Food',         amt:1500,  mo },
        { u:'female', type:'want',   cat:'Mr Price Clothing',       amt:2000,  mo },
        { u:'female', type:'saving', cat:'Emergency Fund',          amt:5000,  mo },
        
        { u:'male',   type:'need',   cat:'Standard Bank Bond',      amt:18500, mo },
        { u:'male',   type:'need',   cat:'Wesbank Vehicle Payment', amt:8200,  mo },
        { u:'male',   type:'need',   cat:'Utilities',               amt:5100,  mo },
        { u:'male',   type:'want',   cat:'Family Entertainment',    amt:3000,  mo },
        { u:'male',   type:'want',   cat:'Sasol Fuel',              amt:2500,  mo },
        { u:'male',   type:'saving', cat:'EasyEquities Investment', amt:5000,  mo },
        { u:'male',   type:'saving', cat:'Savings Account',         amt:6000,  mo }
      );
    }

    for (const b of budgets) {
      const exp = JSON.stringify([{ category: b.cat, amount: b.amt, type: b.type }]);
      await pool.query(
        `INSERT INTO vectraarchlegacy_budget (username, income, expenses, date, budget_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [b.u, b.amt, exp, b.mo, b.type]
      );
    }

    // ════════════════════════════════════════════════════════════
    // 4. FINANCES
    // ════════════════════════════════════════════════════════════
    console.log('4. Seeding recursive transactional history ledger...');
    const finRows = [];

    const seedMonthlyLedger = (yearMonth) => {
      finRows.push(
        ['female', 'Monthly Salary',         45000, 'income',  `${yearMonth}-01`],
        ['male',   'Corporate Salary',       55000, 'income',  `${yearMonth}-01`],
        ['male',   'Rental Income — Flatlet', 4200,  'income',  `${yearMonth}-01`],
        ['male',   'Standard Bank Bond',     18500, 'expense', `${yearMonth}-01`],
        ['female', 'Curro School Fees',        9500,  'expense', `${yearMonth}-02`],
        ['female', 'Discovery Medical Aid',    4500,  'expense', `${yearMonth}-02`],
        ['male',   'Wesbank Vehicle Payment',  8200,  'expense', `${yearMonth}-03`],
        ['male',   'Utilities',               4100,  'expense', `${yearMonth}-03`],
        ['male',   'Cool Ideas Fibre',          999,  'expense', `${yearMonth}-04`],
        ['female', 'SuperSpar Groceries',      3300,  'expense', `${yearMonth}-05`],
        ['male',   'Sasol Fuel',              1200,  'expense', `${yearMonth}-06`],
        ['female', 'Woolworths Food',          1100,  'expense', `${yearMonth}-08`],
        ['male',   'Checkers Hyper run',       2600,  'expense', `${yearMonth}-10`],
        ['female', 'Dis-Chem Pharmacy',         620,  'expense', `${yearMonth}-12`],
        ['female', 'Mr Price Clothing',        1300,  'expense', `${yearMonth}-14`],
        ['female', 'Pick n Pay Weekly Box',    1900,  'expense', `${yearMonth}-17`],
        ['male',   'Takealot Order Delivery',  1500,  'expense', `${yearMonth}-18`],
        ['boy',    'School Uniform & Gear',     550,  'expense', `${yearMonth}-20`],
        ['girl',   'Books & Stationery Extra',   320,  'expense', `${yearMonth}-22`],
        ['male',   'EasyEquities Investment',  5000,  'expense', `${yearMonth}-28`]
      );
    };

    ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].forEach(seedMonthlyLedger);

    finRows.push(
      ['female', 'Bonus Payout Q1',          8500,  'income',  '2026-03-25'],
      ['male',   'Freelance Consulting Side',7500,  'income',  '2026-04-15'],
      ['female', 'Salary Adjustment Top-Up', 2000,  'income',  '2026-05-01'],
      ['male',   'Investment Dividend Return',3150,  'income',  '2026-05-15'],
      ['male',   'BMW Scheduled Service',    4200,  'expense', '2026-05-26']
    );

    const chunkSize = 25;
    for (let i = 0; i < finRows.length; i += chunkSize) {
      const chunk = finRows.slice(i, i + chunkSize);
      await pool.query(
        `INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES ${
          chunk.map((_,idx)=>`($${idx*5+1},$${idx*5+2},$${idx*5+3},$${idx*5+4},$${idx*5+5})`).join(',')
        }`, chunk.flat()
      );
    }
    console.log(`   Seeded ${finRows.length} total active ledger entries.`);

    // ════════════════════════════════════════════════════════════
    // 5. CALENDAR — Explicit mapping, pure dates, smallint logic
    // ════════════════════════════════════════════════════════════
    console.log('5. Distributing calendar event data maps...');
    const calMonths = ['01', '02', '03', '04', '05'];
    for (const m of calMonths) {
      await pool.query(`
        INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, amount, event_color) 
        VALUES
          ('female', 'Strategy Alignment Board meeting', '2026-${m}-02', 0, 'work',    NULL, '#448aff'),
          ('male',   'Corporate Performance Evaluation',  '2026-${m}-03', 0, 'work',    NULL, '#448aff'),
          ('girl',   'School Test & Curriculum Review',   '2026-${m}-11', 0, 'social',  NULL, '#e040fb'),
          ('boy',    'Sports Group Trials / Training',    '2026-${m}-15', 0, 'social',  NULL, '#ffd600'),
          ('female', 'Biokinetics Medical Follow-up',     '2026-${m}-17', 0, 'health',  NULL, '#e91e8c'),
          ('male',   'Weekend Family Braai Event',        '2026-${m}-28', 0, 'social',  NULL, '#ff3b3b');
      `);
    }

    // ════════════════════════════════════════════════════════════
    // 6. GYM WORKOUTS
    // ════════════════════════════════════════════════════════════
    console.log('6. Seeding massive multi-user workout splits...');
    const splits = [
      { u: 'female', day: 'Monday',    ex: 'Barbell Back Squat',       s: 3, r: '10', w: 45,  inc: 1.5 },
      { u: 'female', day: 'Friday',    ex: 'Lat Pulldown',             s: 3, r: '12', w: 30,  inc: 1.0 },
      { u: 'male',   day: 'Monday',    ex: 'Barbell Bench Press',       s: 4, r: '8',  w: 75,  inc: 2.5 },
      { u: 'male',   day: 'Thursday',  ex: 'Barbell Deadlift',         s: 3, r: '5',  w: 110, inc: 4.0 },
      { u: 'girl',   day: 'Tuesday',   ex: 'Steady-state jogging run', s: 1, r: '30', w: 4,   inc: 0.1 },
      { u: 'girl',   day: 'Thursday',  ex: 'Bodyweight Air Squats',    s: 3, r: '15', w: 0,   inc: 0.0 },
      { u: 'boy',    day: 'Wednesday', ex: 'High Intensity Sprints',   s: 1, r: '20', w: 3,   inc: 0.1 },
      { u: 'boy',    day: 'Friday',    ex: 'Bodyweight Push-Up Matrix',s: 3, r: '12', w: 0,   inc: 0.0 }
    ];

    let gymCount = 0;
    for (let week = 0; week < 20; week++) {
      const startW = new Date('2026-01-05');
      startW.setDate(startW.getDate() + (week * 7));

      for (const item of splits) {
        const dStr = startW.toISOString().split('T')[0];
        const computedW = item.w + (week * item.inc);

        await pool.query(
          `INSERT INTO vectraarchlegacy_gymworkout (username, day, exercise, sets, reps, weight, date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [item.u, item.day, item.ex, item.s, item.r, computedW.toFixed(1), dStr]
        );
        gymCount++;
      }
    }
    console.log(`   Populated ${gymCount} multi-user sequential exercise logs.`);

    // ════════════════════════════════════════════════════════════
    // 7. MEALS — Fixed pure YYYY-MM-DD formatting targets
    // ════════════════════════════════════════════════════════════
    console.log('7. Generating sequential cross-user macro logs...');
    let mealCount = 0;
    const dStart = new Date('2026-01-01');
    const dEnd = new Date('2026-05-19'); 
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let d = new Date(dStart); d <= dEnd; d.setDate(d.getDate() + 1)) {
      const dayName = dayNames[d.getDay()];
      const dString = d.toISOString().split('T')[0];

      // Female
      await pool.query(`
        INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date)
        VALUES 
          ('female', $1, 'breakfast', 'Oatmeal with berries', 320, $2),
          ('female', $1, 'lunch', 'Grilled chicken salad', 450, $2),
          ('female', $1, 'dinner', 'Baked fish with quinoa', 510, $2);`, 
        [dayName, dString]);

      // Male
      await pool.query(`
        INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date)
        VALUES 
          ('male', $1, 'breakfast', 'Protein shake with banana and oats', 520, $2),
          ('male', $1, 'lunch', 'Chicken breast with sweet potato mash', 680, $2),
          ('male', $1, 'dinner', 'Lean beef stir-fry with noodles', 720, $2);`, 
        [dayName, dString]);

      // Girl
      await pool.query(`
        INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date)
        VALUES 
          ('girl', $1, 'breakfast', 'Greek yogurt with mixed nuts', 410, $2),
          ('girl', $1, 'lunch', 'Turkey whole-wheat wrap', 420, $2),
          ('girl', $1, 'dinner', 'Stir-fried tofu jasmine bowl', 530, $2);`, 
        [dayName, dString]);

      // Boy
      await pool.query(`
        INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date)
        VALUES 
          ('boy', $1, 'breakfast', 'Peanut butter toast on wheat', 380, $2),
          ('boy', $1, 'lunch', 'Quinoa bowl with shredded beef', 590, $2),
          ('boy', $1, 'dinner', 'Lean chicken stir-fry variant', 650, $2);`, 
        [dayName, dString]);

      mealCount += 12;
    }
    console.log(`   Generated ${mealCount} nutritional schedule entries.`);

    // ════════════════════════════════════════════════════════════
    // 8. PERIOD CYCLES
    // ════════════════════════════════════════════════════════════
    console.log('8. Running health array dependencies...');
    const cycMonths = ['01', '02', '03', '04', '05'];
    for (const m of cycMonths) {
      await pool.query(`
        INSERT INTO vectraarchlegacy_period (username, start_date, end_date, cycle_length, symptoms, date) VALUES
        ('female', '2026-${m}-05', '2026-${m}-10', 28, 'Cramps, Fatigue', '2026-${m}-05'),
        ('girl',   '2026-${m}-12', '2026-${m}-16', 30, 'Bloating, Mild Headache', '2026-${m}-12');
      `);
    }

    console.log('\x1b[32m%s\x1b[0m', '\n✓ SUCCESS — Clean Dataset Synchronized!');
    console.log(`  Metrics Loaded: ${finRows.length} financials | ${gymCount} exercises | ${mealCount} meals.`);

  } catch(err) {
    console.error('\x1b[31mCRITICAL SEED ERROR:\x1b[0m', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

run();
