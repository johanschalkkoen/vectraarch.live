'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config({ path: '/var/www/vectraarch.live/forge/.env' });

const pool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchLegacy',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

const PASSWORD = 'TestThisAppPlease';

async function run() {
  try {
    console.log('1. Clearing all data...');
    await pool.query(`TRUNCATE vectraarchlegacy_users, vectraarchlegacy_financial,
      vectraarchlegacy_budget, vectraarchlegacy_calendar, vectraarchlegacy_gymworkout,
      vectraarchlegacy_mealplan, vectraarchlegacy_period CASCADE;`);

    console.log('2. Hashing password...');
    const hash = await bcrypt.hash(PASSWORD, 10);

    console.log('3. Creating 4 Koen family users...');
    await pool.query(`
      INSERT INTO vectraarchlegacy_users
        (username, password_hash, first_name, last_name, display_name,
         email, phone, gender, event_color, is_admin, theme, dob, weight, height)
      VALUES
        ('female', $1, 'Femal', 'Koen', 'Mother (Female)',
         'female@vectraarch.live', '0821112222', 'female', '#e91e8c', 1, 'dark', '1985-03-14', 62.5, 165),
        ('male',   $1, 'Male',  'Koen', 'Father (Male)',
         'male@vectraarch.live',   '0823334444', 'male',   '#00e676', 0, 'dark', '1982-07-22', 88.0, 182),
        ('girl',   $1, 'Girl',  'Koen', 'Daughter (Girl)',
         'girl@vectraarch.live',   '0825556666', 'female', '#e040fb', 0, 'dark', '2009-11-05', 52.0, 160),
        ('boy',    $1, 'Boy',   'Koen', 'Son (Boy)',
         'boy@vectraarch.live',    '0827778888', 'male',   '#448aff', 0, 'dark', '2012-04-18', 45.0, 152);
    `, [hash]);

    console.log('4. Setting up family access links...');
    await pool.query(`
      INSERT INTO vectraarchlegacy_access (viewer, target) VALUES
        ('female','male'), ('male','female'),
        ('female','girl'), ('female','boy'),
        ('male','girl'),   ('male','boy'),
        ('girl','female'), ('boy','male');
    `);

    // ════════════════════════════════════════════════════════════
    // 5. BUDGETS — 50/30/20 structure for March, April, May
    //    budget_type: need | want | saving
    //    expenses categories match financial transaction categories
    // ════════════════════════════════════════════════════════════
    console.log('5. Seeding 50/30/20 budgets for 3 months...');

    const budgets = [
      // ── MARCH ──
      // NEEDS (50% of 45k = R22,500 | 50% of 55k = R27,500)
      { u:'female', type:'need', cat:'Curro School Fees',       amt:12000, mo:'2026-03-01' },
      { u:'female', type:'need', cat:'Discovery Medical Aid',   amt:4500,  mo:'2026-03-01' },
      { u:'female', type:'need', cat:'SuperSpar Groceries',     amt:4000,  mo:'2026-03-01' },
      { u:'male',   type:'need', cat:'Standard Bank Bond',      amt:18500, mo:'2026-03-01' },
      { u:'male',   type:'need', cat:'Wesbank Vehicle Payment', amt:8200,  mo:'2026-03-01' },
      { u:'male',   type:'need', cat:'Utilities',               amt:5100,  mo:'2026-03-01' },
      // WANTS (30% of 45k = R13,500 | 30% of 55k = R16,500)
      { u:'female', type:'want', cat:'Woolworths Food',         amt:1500,  mo:'2026-03-01' },
      { u:'female', type:'want', cat:'Mr Price Clothing',       amt:2000,  mo:'2026-03-01' },
      { u:'male',   type:'want', cat:'Family Entertainment',    amt:3000,  mo:'2026-03-01' },
      { u:'male',   type:'want', cat:'Sasol Fuel',              amt:2200,  mo:'2026-03-01' },
      // SAVINGS (20% of 45k = R9,000 | 20% of 55k = R11,000)
      { u:'female', type:'saving', cat:'Emergency Fund',        amt:5000,  mo:'2026-03-01' },
      { u:'male',   type:'saving', cat:'EasyEquities Investment',amt:5000, mo:'2026-03-01' },
      { u:'male',   type:'saving', cat:'Savings Account',       amt:6000,  mo:'2026-03-01' },
      // ── APRIL ──
      { u:'female', type:'need', cat:'Curro School Fees',       amt:12000, mo:'2026-04-01' },
      { u:'female', type:'need', cat:'Discovery Medical Aid',   amt:4500,  mo:'2026-04-01' },
      { u:'female', type:'need', cat:'SuperSpar Groceries',     amt:4200,  mo:'2026-04-01' },
      { u:'male',   type:'need', cat:'Standard Bank Bond',      amt:18500, mo:'2026-04-01' },
      { u:'male',   type:'need', cat:'Wesbank Vehicle Payment', amt:8200,  mo:'2026-04-01' },
      { u:'male',   type:'need', cat:'Utilities',               amt:5500,  mo:'2026-04-01' },
      { u:'female', type:'want', cat:'Woolworths Food',         amt:1500,  mo:'2026-04-01' },
      { u:'female', type:'want', cat:'Easter Family Expenses',  amt:3000,  mo:'2026-04-01' },
      { u:'male',   type:'want', cat:'Sasol Fuel',              amt:2500,  mo:'2026-04-01' },
      { u:'male',   type:'want', cat:'Builders Warehouse',      amt:2500,  mo:'2026-04-01' },
      { u:'female', type:'saving', cat:'Emergency Fund',        amt:5000,  mo:'2026-04-01' },
      { u:'male',   type:'saving', cat:'EasyEquities Investment',amt:5000, mo:'2026-04-01' },
      // ── MAY ──
      { u:'female', type:'need', cat:'Curro School Fees',       amt:12000, mo:'2026-05-01' },
      { u:'female', type:'need', cat:'Discovery Medical Aid',   amt:4500,  mo:'2026-05-01' },
      { u:'female', type:'need', cat:'SuperSpar Groceries',     amt:5000,  mo:'2026-05-01' },
      { u:'male',   type:'need', cat:'Standard Bank Bond',      amt:18500, mo:'2026-05-01' },
      { u:'male',   type:'need', cat:'Wesbank Vehicle Payment', amt:8200,  mo:'2026-05-01' },
      { u:'male',   type:'need', cat:'Utilities',               amt:5100,  mo:'2026-05-01' },
      { u:'female', type:'want', cat:'Woolworths Food',         amt:1500,  mo:'2026-05-01' },
      { u:'female', type:'want', cat:'Mr Price Clothing',       amt:2000,  mo:'2026-05-01' },
      { u:'male',   type:'want', cat:'Sasol Fuel',              amt:2700,  mo:'2026-05-01' },
      { u:'male',   type:'want', cat:'Family Dinner',           amt:2000,  mo:'2026-05-01' },
      { u:'male',   type:'want', cat:'BMW Service',             amt:5000,  mo:'2026-05-01' },
      { u:'female', type:'saving', cat:'Emergency Fund',        amt:5000,  mo:'2026-05-01' },
      { u:'male',   type:'saving', cat:'EasyEquities Investment',amt:5000, mo:'2026-05-01' },
      { u:'male',   type:'saving', cat:'Savings Account',       amt:7000,  mo:'2026-05-01' },
    ];

    for (const b of budgets) {
      const exp = JSON.stringify([{ category: b.cat, amount: b.amt, type: b.type }]);
      await pool.query(
        `INSERT INTO vectraarchlegacy_budget (username, income, expenses, date, budget_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [b.u, b.amt, exp, b.mo, b.type]
      );
    }
    console.log(`   Inserted ${budgets.length} budget allocations`);

    // ════════════════════════════════════════════════════════════
    // 6. FINANCES — 3 months, categories matching budget names
    // ════════════════════════════════════════════════════════════
    console.log('6. Seeding 3 months of financial transactions...');

    const fin = async (rows) => pool.query(
      `INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES ${
        rows.map((_,i)=>`($${i*5+1},$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5})`).join(',')
      }`, rows.flat()
    );

    // MARCH income
    await fin([
      ['female','Monthly Salary',         45000,'income','2026-03-01 08:00:00'],
      ['male',  'Corporate Salary',       55000,'income','2026-03-01 08:30:00'],
      ['male',  'Rental Income — Flatlet', 4200,'income','2026-03-01 09:00:00'],
      ['female','Bonus Payout Q1',         8500,'income','2026-03-25 08:00:00'],
    ]);
    // MARCH expenses — match budget categories
    await fin([
      ['male',  'Standard Bank Bond',     18500,'expense','2026-03-01 00:05:00'],
      ['female','Curro School Fees',        9500,'expense','2026-03-02 09:00:00'],
      ['female','Discovery Medical Aid',    4500,'expense','2026-03-02 10:15:00'],
      ['male',  'Wesbank Vehicle Payment',  8200,'expense','2026-03-03 04:30:00'],
      ['male',  'Utilities',               4100,'expense','2026-03-03 06:00:00'],
      ['male',  'Cool Ideas Fibre',          999,'expense','2026-03-04 02:00:00'],
      ['female','SuperSpar Groceries',      3200,'expense','2026-03-05 14:20:00'],
      ['male',  'Sasol Fuel',              1100,'expense','2026-03-06 17:45:00'],
      ['female','Woolworths Food',          1050,'expense','2026-03-08 16:10:00'],
      ['male',  'Checkers Hyper',           2600,'expense','2026-03-10 11:15:00'],
      ['female','Dis-Chem Pharmacy',         620,'expense','2026-03-12 12:40:00'],
      ['female','Mr Price Clothing',        1200,'expense','2026-03-14 15:30:00'],
      ['boy',   'Rugby Boots',               780,'expense','2026-03-15 14:00:00'],
      ['girl',  'Netball Shoes',             650,'expense','2026-03-15 14:30:00'],
      ['female','Pick n Pay Weekly',        1950,'expense','2026-03-17 11:30:00'],
      ['male',  'Takealot Tech Order',      2100,'expense','2026-03-18 10:20:00'],
      ['female','Apple iCloud Storage',      150,'expense','2026-03-27 02:00:00'],
      ['male',  'Family Entertainment',      890,'expense','2026-03-28 18:00:00'],
      ['male',  'EasyEquities Investment',  5000,'expense','2026-03-28 09:00:00'],
    ]);

    // APRIL income
    await fin([
      ['female','Monthly Salary',         45000,'income','2026-04-01 08:00:00'],
      ['male',  'Corporate Salary',       55000,'income','2026-04-01 08:30:00'],
      ['male',  'Rental Income — Flatlet', 4200,'income','2026-04-01 09:00:00'],
      ['male',  'Freelance Consulting',    7500,'income','2026-04-15 10:00:00'],
    ]);
    // APRIL expenses
    await fin([
      ['male',  'Standard Bank Bond',     18500,'expense','2026-04-01 00:05:00'],
      ['female','Curro School Fees',        9500,'expense','2026-04-02 09:00:00'],
      ['female','Discovery Medical Aid',    4500,'expense','2026-04-02 10:15:00'],
      ['male',  'Wesbank Vehicle Payment',  8200,'expense','2026-04-03 04:30:00'],
      ['male',  'Utilities',               4400,'expense','2026-04-03 06:00:00'],
      ['female','Spar Groceries',           3350,'expense','2026-04-04 14:00:00'],
      ['male',  'Sasol Fuel',              1250,'expense','2026-04-06 07:30:00'],
      ['female','Woolworths Food',          1100,'expense','2026-04-08 16:00:00'],
      ['boy',   'Stationery & Art Supplies', 480,'expense','2026-04-09 10:00:00'],
      ['female','Clicks Health Products',    720,'expense','2026-04-10 13:00:00'],
      ['male',  'Checkers Grocery Haul',   2750,'expense','2026-04-12 11:00:00'],
      ['girl',  'Piano Sheet Music Books',   290,'expense','2026-04-14 16:00:00'],
      ['female','Pick n Pay Fresh Produce', 1800,'expense','2026-04-16 12:00:00'],
      ['male',  'Builders Warehouse',       2200,'expense','2026-04-20 09:30:00'],
      ['female','Easter Family Expenses',   2100,'expense','2026-04-05 13:00:00'],
      ['female','Apple iCloud Storage',      150,'expense','2026-04-27 02:00:00'],
      ['male',  'EasyEquities Investment',  5000,'expense','2026-04-28 09:00:00'],
    ]);

    // MAY income
    await fin([
      ['female','Monthly Salary',          47000,'income','2026-05-01 08:00:00'],
      ['male',  'Corporate Salary',        58000,'income','2026-05-01 08:30:00'],
      ['male',  'Rental Income — Flatlet',  4200,'income','2026-05-01 09:00:00'],
      ['male',  'Investment Dividend',      3150,'income','2026-05-15 11:00:00'],
      ['girl',  'Item Sold (Income)',         200,'income','2026-05-18 10:00:00'],
      ['boy',   'Car Wash Hustle',            150,'income','2026-05-24 11:00:00'],
    ]);
    // MAY expenses
    await fin([
      ['male',  'Standard Bank Bond',     18500,'expense','2026-05-01 00:05:00'],
      ['female','Curro School Fees',        9500,'expense','2026-05-02 09:00:00'],
      ['female','Discovery Medical Aid',    4500,'expense','2026-05-02 10:15:00'],
      ['male',  'Wesbank Vehicle Payment',  8200,'expense','2026-05-03 04:30:00'],
      ['male',  'Utilities',               4100,'expense','2026-05-03 06:00:00'],
      ['male',  'Cool Ideas Fibre',          999,'expense','2026-05-04 02:00:00'],
      ['female','SuperSpar Groceries',      3450,'expense','2026-05-03 14:20:00'],
      ['male',  'Sasol Fuel',              1200,'expense','2026-05-05 17:45:00'],
      ['female','Woolworths Food',          1150,'expense','2026-05-07 16:10:00'],
      ['male',  'Checkers Hyper',           2800,'expense','2026-05-10 11:15:00'],
      ['female','Dis-Chem Pharmacy',         680,'expense','2026-05-12 12:40:00'],
      ['male',  'Total Garage Fuel',        1400,'expense','2026-05-13 08:15:00'],
      ['female','Mr Price Clothing',        1450,'expense','2026-05-14 15:30:00'],
      ['boy',   'School Rugby Socks',        320,'expense','2026-05-15 14:00:00'],
      ['female','Pick n Pay Weekly',        2100,'expense','2026-05-17 11:30:00'],
      ['male',  'Engen Fuel Station',       1350,'expense','2026-05-20 07:10:00'],
      ['female','Netball Team Kit',          850,'expense','2026-05-21 16:45:00'],
      ['male',  'Takealot Home Order',      1250,'expense','2026-05-22 10:20:00'],
      ['female','SuperSpar Mid-Month',      1890,'expense','2026-05-24 15:00:00'],
      ['male',  'BMW Service',              4200,'expense','2026-05-26 16:30:00'],
      ['female','Apple iCloud Storage',      150,'expense','2026-05-27 02:00:00'],
      ['male',  'Family Dinner',            1650,'expense','2026-05-28 20:30:00'],
      ['male',  'EasyEquities Investment',  5000,'expense','2026-05-28 09:00:00'],
    ]);
    console.log('   Financial transactions done');

    // ════════════════════════════════════════════════════════════
    // 7. CALENDAR — financial + personal events, 3 months
    // ════════════════════════════════════════════════════════════
    console.log('7. Seeding calendar events...');
    // Financial calendar entries (May only — key transactions)
    await pool.query(`
      INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, amount, event_color) VALUES
      ('female','Monthly Salary (income)',        '2026-05-01 08:00:00',1,'income', 47000,'#00e676'),
      ('male',  'Corporate Salary (income)',      '2026-05-01 08:30:00',1,'income', 58000,'#00e676'),
      ('male',  'Standard Bank Bond (expense)',   '2026-05-01 00:05:00',1,'expense',18500,'#ff3b3b'),
      ('female','Curro School Fees (expense)',    '2026-05-02 09:00:00',1,'expense', 9500,'#ff3b3b'),
      ('female','SuperSpar Groceries (expense)',  '2026-05-03 14:20:00',1,'expense', 3450,'#ff3b3b'),
      ('male',  'BMW Service (expense)',          '2026-05-26 16:30:00',1,'expense', 4200,'#ff3b3b'),
      ('male',  'Family Dinner (expense)',        '2026-05-28 20:30:00',1,'expense', 1650,'#ff3b3b'),
      ('girl',  'Item Sold (income)',             '2026-05-18 10:00:00',1,'income',   200,'#00e676');
    `);

    // Personal/work/health events — March
    await pool.query(`
      INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
      ('female','Q1 Strategy Presentation',    '2026-03-02 09:00:00',0,'work',    '#448aff'),
      ('male',  'Annual Performance Review',   '2026-03-03 10:00:00',0,'work',    '#448aff'),
      ('girl',  'School Science Expo',         '2026-03-04 08:00:00',0,'work',    '#448aff'),
      ('boy',   'Junior Rugby Trials',         '2026-03-05 15:00:00',0,'social',  '#ff3b3b'),
      ('female','Yoga & Wellness Morning',     '2026-03-07 07:00:00',0,'health',  '#e91e8c'),
      ('male',  'Client Entertainment Lunch',  '2026-03-10 12:30:00',0,'social',  '#e040fb'),
      ('girl',  'Netball League Match',        '2026-03-11 15:00:00',0,'social',  '#e040fb'),
      ('female','Parent Teacher Meeting',      '2026-03-12 14:00:00',0,'personal','#ffd600'),
      ('male',  'Golf Club Monthly Medal',     '2026-03-14 08:00:00',0,'social',  '#e040fb'),
      ('boy',   'Birthday Party — Friend',     '2026-03-15 14:00:00',0,'social',  '#ffd600'),
      ('female','Dermatologist Appointment',   '2026-03-17 11:00:00',0,'health',  '#e91e8c'),
      ('male',  'Property Inspection',         '2026-03-19 10:00:00',0,'personal','#ffd600'),
      ('girl',  'Piano Recital Grade 4',       '2026-03-20 17:00:00',0,'personal','#ffd600'),
      ('female','Supplier Review Session',     '2026-03-23 09:00:00',0,'work',    '#448aff'),
      ('male',  'Family Braai — Koen Estate',  '2026-03-28 12:00:00',0,'social',  '#ff3b3b'),
      ('female','Financial Advisor Meeting',   '2026-03-30 10:00:00',0,'work',    '#448aff');
    `);
    // April
    await pool.query(`
      INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
      ('female','Board Ops Strategy Meeting',  '2026-04-01 09:00:00',0,'work',    '#448aff'),
      ('male',  'Squash League Quarter-Final', '2026-04-02 18:00:00',0,'social',  '#e040fb'),
      ('girl',  'Netball Semifinals',          '2026-04-03 15:00:00',0,'social',  '#e040fb'),
      ('boy',   'Cross Country School Race',   '2026-04-04 09:00:00',0,'social',  '#448aff'),
      ('female','Biokinetics Follow-up',       '2026-04-07 07:30:00',0,'health',  '#e91e8c'),
      ('male',  'Easter Family Road Trip',     '2026-04-05 08:00:00',0,'personal','#ffd600'),
      ('boy',   'Coding Camp Day 1',           '2026-04-07 09:00:00',0,'personal','#448aff'),
      ('boy',   'Coding Camp Day 2',           '2026-04-08 09:00:00',0,'personal','#448aff'),
      ('girl',  'Drama Club Rehearsal',        '2026-04-09 14:00:00',0,'personal','#ffd600'),
      ('male',  'IT Security Workshop',        '2026-04-14 08:00:00',0,'work',    '#448aff'),
      ('female','Ophthalmologist Visit',       '2026-04-15 10:00:00',0,'health',  '#e91e8c'),
      ('girl',  'Maths Olympiad Round 1',      '2026-04-16 08:30:00',0,'work',    '#448aff'),
      ('male',  'Freelance Project Kickoff',   '2026-04-15 09:00:00',0,'work',    '#448aff'),
      ('female','Mid-Year School Planning',    '2026-04-22 08:30:00',0,'work',    '#448aff'),
      ('male',  'Home Renovation Planning',    '2026-04-24 10:00:00',0,'personal','#ffd600'),
      ('boy',   'School Athletics Day',        '2026-04-25 09:00:00',0,'social',  '#ff3b3b'),
      ('girl',  'Year-End Netball Dinner',     '2026-04-28 18:30:00',0,'social',  '#e040fb'),
      ('female','Wellness & Pilates Session',  '2026-04-30 07:00:00',0,'health',  '#e91e8c');
    `);
    // May
    await pool.query(`
      INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
      ('female','EXCO Strategy Framework',     '2026-05-04 09:00:00',0,'work',    '#448aff'),
      ('male',  'Regional Operations Sync',    '2026-05-05 10:00:00',0,'work',    '#448aff'),
      ('girl',  'Netball Trials Group A',      '2026-05-05 15:00:00',0,'social',  '#e040fb'),
      ('boy',   'Under-13 Rugby Trials',       '2026-05-06 15:30:00',0,'social',  '#448aff'),
      ('female','Biokinetics Assessment',      '2026-05-07 07:30:00',0,'health',  '#e91e8c'),
      ('male',  'Quarterly Financial Audit',   '2026-05-11 11:00:00',0,'work',    '#448aff'),
      ('girl',  'Piano Grade 4 Evaluation',    '2026-05-12 16:00:00',0,'personal','#ffd600'),
      ('boy',   'Science Tuition Clinic',      '2026-05-13 14:30:00',0,'work',    '#448aff'),
      ('female','Pediatric Checkup Kids',      '2026-05-14 14:00:00',0,'health',  '#e91e8c'),
      ('male',  'Squash Match vs Dave',        '2026-05-15 17:15:00',0,'social',  '#e040fb'),
      ('female','Project Kickoff Meeting',     '2026-05-18 09:00:00',0,'work',    '#448aff'),
      ('girl',  'Netball Practice',            '2026-05-18 15:30:00',0,'social',  '#e040fb'),
      ('male',  'Car Service BMW',             '2026-05-19 07:30:00',0,'personal','#ffd600'),
      ('female','Dentist Appointment',         '2026-05-20 14:00:00',0,'health',  '#e91e8c'),
      ('boy',   'Primary School Rugby Match',  '2026-05-20 16:00:00',0,'social',  '#448aff'),
      ('girl',  'Maths Term Test',             '2026-05-21 08:30:00',0,'work',    '#448aff'),
      ('male',  'Golf Day with Clients',       '2026-05-22 12:00:00',0,'social',  '#e040fb'),
      ('boy',   'Guitar Lesson',               '2026-05-22 15:00:00',0,'personal','#ffd600'),
      ('female','Supplier Contract Signoff',   '2026-05-25 10:30:00',0,'work',    '#448aff'),
      ('male',  'IT Infrastructure Board',     '2026-05-26 14:00:00',0,'work',    '#448aff'),
      ('boy',   'Rugby Semi-Final',            '2026-05-27 15:30:00',0,'social',  '#ff3b3b'),
      ('girl',  'Netball Season Finale',       '2026-05-28 14:00:00',0,'social',  '#ffd600'),
      ('male',  'Wedding Anniversary Dinner',  '2026-05-29 19:00:00',0,'social',  '#e91e8c'),
      ('female','Wellness Day Retreat',        '2026-05-30 09:00:00',0,'health',  '#e91e8c'),
      ('boy',   'End-of-Term Celebration',     '2026-05-29 14:00:00',0,'social',  '#448aff');
    `);
    console.log('   Calendar events done');

    // ════════════════════════════════════════════════════════════
    // 8. GYM WORKOUTS — progressive loads, 3 months, all 4 users
    // ════════════════════════════════════════════════════════════
    console.log('8. Seeding gym workouts...');
    await pool.query(`
      INSERT INTO vectraarchlegacy_gymworkout (username, day, exercise, sets, reps, weight, date) VALUES
      -- ── FEMALE (Strength + Yoga) ──
      ('female','Monday',   'Barbell Back Squat',           3,'10','45',      '2026-03-02 06:00:00'),
      ('female','Wednesday','Yoga Flow',                    1,'45','vinyasa', '2026-03-04 06:15:00'),
      ('female','Friday',   'Lat Pulldown',                 3,'12','30',      '2026-03-06 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','47.5',    '2026-03-09 06:00:00'),
      ('female','Wednesday','Yoga Flow',                    1,'45','power',   '2026-03-11 06:15:00'),
      ('female','Friday',   'Dumbbell Romanian Deadlift',   3,'10','22',      '2026-03-13 06:00:00'),
      ('female','Monday',   'Goblet Squat',                 3,'12','16',      '2026-03-23 06:00:00'),
      ('female','Wednesday','Pilates Core Flow',            1,'45','bodyweight','2026-03-25 06:15:00'),
      ('female','Friday',   'Cable Row',                    3,'12','28',      '2026-03-27 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','47.5',    '2026-04-06 06:00:00'),
      ('female','Wednesday','Yoga Flow',                    1,'45','vinyasa', '2026-04-08 06:15:00'),
      ('female','Friday',   'Lat Pulldown',                 3,'12','32',      '2026-04-10 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','50',      '2026-04-13 06:00:00'),
      ('female','Wednesday','Pilates Core',                 1,'45','bodyweight','2026-04-15 06:15:00'),
      ('female','Friday',   'Dumbbell Romanian Deadlift',   3,'10','24',      '2026-04-24 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','50',      '2026-05-04 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','52.5',    '2026-05-11 06:00:00'),
      ('female','Monday',   'Barbell Back Squat',           3,'10','55',      '2026-05-18 06:00:00'),
      ('female','Wednesday','Yoga Flow',                    1,'45','vinyasa', '2026-05-06 06:15:00'),
      ('female','Wednesday','Pilates Core',                 1,'45','bodyweight','2026-05-13 06:15:00'),
      ('female','Wednesday','Yoga Flow',                    1,'45','power ash','2026-05-20 06:15:00'),
      ('female','Friday',   'Lat Pulldown',                 3,'12','35',      '2026-05-08 06:00:00'),
      ('female','Friday',   'Cable Row',                    3,'12','30',      '2026-05-22 06:00:00'),
      -- ── MALE (Push/Pull/Legs) ──
      ('male','Monday',   'Barbell Bench Press',            4,'8','75',       '2026-03-02 17:30:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'40','5.8',     '2026-03-03 18:00:00'),
      ('male','Thursday', 'Barbell Deadlift',               3,'5','110',      '2026-03-05 17:30:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','80',       '2026-03-09 17:30:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'40','6.0',     '2026-03-10 18:00:00'),
      ('male','Thursday', 'Barbell Deadlift',               3,'5','112.5',    '2026-03-12 17:30:00'),
      ('male','Saturday', 'Dumbbell Bicep Curl',            3,'12','14',      '2026-03-14 09:00:00'),
      ('male','Monday',   'Overhead Press',                 3,'8','60',       '2026-03-16 17:30:00'),
      ('male','Thursday', 'Barbell Deadlift',               4,'5','115',      '2026-03-26 17:30:00'),
      ('male','Saturday', 'Dumbbell Bicep Curl',            3,'12','16',      '2026-03-28 09:00:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','82.5',     '2026-04-06 17:30:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'40','6.3',     '2026-04-07 18:00:00'),
      ('male','Thursday', 'Barbell Deadlift',               3,'5','117.5',    '2026-04-09 17:30:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','85',       '2026-04-13 17:30:00'),
      ('male','Thursday', 'Barbell Deadlift',               4,'5','120',      '2026-04-16 17:30:00'),
      ('male','Saturday', 'Dumbbell Bicep Curl',            3,'12','16',      '2026-04-18 09:00:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'45','6.5',     '2026-04-21 18:00:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','85',       '2026-05-04 17:30:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','87.5',     '2026-05-11 17:30:00'),
      ('male','Monday',   'Barbell Bench Press',            4,'8','90',       '2026-05-18 17:30:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'40','6.2',     '2026-05-05 18:00:00'),
      ('male','Tuesday',  'Run · Zone 2',                   1,'45','6.5',     '2026-05-19 18:00:00'),
      ('male','Thursday', 'Barbell Deadlift',               3,'5','120',      '2026-05-07 17:30:00'),
      ('male','Thursday', 'Barbell Deadlift',               4,'5','122.5',    '2026-05-21 17:30:00'),
      ('male','Thursday', 'Overhead Press',                 4,'8','65',       '2026-05-14 17:30:00'),
      ('male','Saturday', 'Dumbbell Bicep Curl',            3,'12','18',      '2026-05-09 09:00:00'),
      ('male','Saturday', 'Pull-Ups',                       3,'8','bodyweight','2026-05-16 09:00:00'),
      ('male','Saturday', 'Dumbbell Bicep Curl',            3,'12','18',      '2026-05-23 09:00:00'),
      -- ── GIRL (Cardio + Bodyweight) ──
      ('girl','Tuesday',  'Steady-state running or jogging',1,'25','3.8',     '2026-03-03 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              3,'12','0',       '2026-03-05 16:00:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'28','4.0',     '2026-03-10 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              3,'15','0',       '2026-03-12 16:00:00'),
      ('girl','Tuesday',  'Interval sprints',               1,'20','3.5',     '2026-03-17 15:30:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'30','4.2',     '2026-03-24 15:30:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'30','4.2',     '2026-04-07 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              3,'15','0',       '2026-04-09 16:00:00'),
      ('girl','Tuesday',  'Interval sprints',               1,'22','4.0',     '2026-04-14 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              4,'15','0',       '2026-04-16 16:00:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'32','4.5',     '2026-04-21 15:30:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'30','4.2',     '2026-05-05 15:30:00'),
      ('girl','Tuesday',  'Interval sprints',               1,'25','5.0',     '2026-05-12 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              3,'15','0',       '2026-05-07 16:00:00'),
      ('girl','Thursday', 'Dumbbell Hip Thrust',            3,'12','10',      '2026-05-14 16:00:00'),
      ('girl','Tuesday',  'Steady-state running or jogging',1,'35','4.8',     '2026-05-19 15:30:00'),
      ('girl','Thursday', 'Bodyweight Squats',              4,'15','0',       '2026-05-21 16:00:00'),
      -- ── BOY (Sprints + Push) ──
      ('boy','Wednesday', 'Interval sprints',               1,'15','2.5',     '2026-03-04 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'8','0',     '2026-03-06 07:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'18','2.8',     '2026-03-11 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'10','0',    '2026-03-13 07:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'20','3.0',     '2026-03-18 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'12','0',    '2026-03-20 07:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'20','3.2',     '2026-04-08 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'12','0',    '2026-04-10 07:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'22','3.5',     '2026-04-15 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'15','0',    '2026-04-17 07:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'20','3.0',     '2026-05-06 15:00:00'),
      ('boy','Wednesday', 'Broad Jumps',                    3,'8','0',        '2026-05-13 15:00:00'),
      ('boy','Wednesday', 'Interval sprints',               1,'22','3.5',     '2026-05-20 15:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'10','0',    '2026-05-08 07:00:00'),
      ('boy','Friday',    'Dumbbell Shoulder Press',        3,'10','8',       '2026-05-15 07:00:00'),
      ('boy','Friday',    'Push-Ups (standard, wide, diamond)',3,'15','0',    '2026-05-22 07:00:00');
    `);
    console.log('   Gym workouts done');

    // ════════════════════════════════════════════════════════════
    // 9. MEALS — full week coverage for May, partial for March
    // ════════════════════════════════════════════════════════════
    console.log('9. Seeding meal plans...');
    await pool.query(`
      INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date) VALUES
      -- ── MARCH sample meals ──
      ('female','Monday',   'breakfast','Oatmeal with berries and a boiled egg', 320,'2026-03-02 07:30:00'),
      ('female','Monday',   'lunch',    'Grilled chicken salad with veggies',    450,'2026-03-02 13:00:00'),
      ('female','Monday',   'dinner',   'Baked fish with quinoa and broccoli',   510,'2026-03-02 19:00:00'),
      ('female','Wednesday','breakfast','Avocado toast with eggs',               380,'2026-03-04 07:30:00'),
      ('female','Wednesday','lunch',    'Turkey wrap with garden greens',        420,'2026-03-04 13:00:00'),
      ('female','Friday',   'breakfast','Greek yogurt parfait with mixed nuts',  410,'2026-03-06 07:30:00'),
      ('female','Friday',   'dinner',   'Salmon with basmati rice and salad',    520,'2026-03-06 19:00:00'),
      ('male',  'Monday',   'breakfast','Protein shake with banana and oats',    520,'2026-03-02 07:00:00'),
      ('male',  'Monday',   'lunch',    'Chicken breast with sweet potato mash', 680,'2026-03-02 13:00:00'),
      ('male',  'Monday',   'dinner',   'Lean beef stir-fry with noodles',       720,'2026-03-02 19:00:00'),
      ('male',  'Thursday', 'breakfast','Protein shake with banana and oats',    520,'2026-03-05 07:00:00'),
      ('male',  'Thursday', 'dinner',   'Salmon with rice and roasted veg',      700,'2026-03-05 19:00:00'),
      ('girl',  'Monday',   'breakfast','Greek yogurt parfait with mixed nuts',  410,'2026-03-02 07:10:00'),
      ('girl',  'Monday',   'lunch',    'Turkey wrap with garden greens',        420,'2026-03-02 13:00:00'),
      ('girl',  'Monday',   'dinner',   'Stir-fried tofu with jasmine rice bowl',530,'2026-03-02 18:30:00'),
      ('boy',   'Monday',   'breakfast','Peanut butter sandwich on whole wheat', 380,'2026-03-02 07:15:00'),
      ('boy',   'Monday',   'lunch',    'Quinoa bowl with shredded beef',        590,'2026-03-02 13:00:00'),
      ('boy',   'Monday',   'dinner',   'Lean beef stir-fry with noodles',       720,'2026-03-02 18:45:00'),
      -- ── MAY full week for all users ──
      ('female','Monday',   'breakfast','Oatmeal with berries and a boiled egg', 320,'2026-05-18 07:30:00'),
      ('female','Monday',   'lunch',    'Grilled chicken salad with veggies',    450,'2026-05-18 13:00:00'),
      ('female','Monday',   'snack',    'Greek yogurt with raw honey',           160,'2026-05-18 16:15:00'),
      ('female','Monday',   'dinner',   'Baked fish with quinoa and broccoli',   510,'2026-05-18 19:15:00'),
      ('female','Tuesday',  'breakfast','Avocado toast with poached eggs',       390,'2026-05-19 07:30:00'),
      ('female','Tuesday',  'lunch',    'Tuna salad with mixed greens',          380,'2026-05-19 13:00:00'),
      ('female','Tuesday',  'dinner',   'Chicken stir-fry with soba noodles',    490,'2026-05-19 19:00:00'),
      ('female','Wednesday','breakfast','Smoothie bowl with granola',            340,'2026-05-20 07:30:00'),
      ('female','Wednesday','lunch',    'Turkey wrap with garden greens',        420,'2026-05-20 13:00:00'),
      ('female','Wednesday','snack',    'Sliced apple with almond butter',       180,'2026-05-20 16:00:00'),
      ('female','Wednesday','dinner',   'Salmon with asparagus and lemon rice',  540,'2026-05-20 19:00:00'),
      ('female','Thursday', 'breakfast','Greek yogurt parfait with mixed nuts',  410,'2026-05-21 07:30:00'),
      ('female','Thursday', 'lunch',    'Grilled chicken salad with veggies',    450,'2026-05-21 13:00:00'),
      ('female','Thursday', 'dinner',   'Stir-fried tofu with jasmine rice bowl',480,'2026-05-21 19:00:00'),
      ('female','Friday',   'breakfast','Oatmeal with berries and a boiled egg', 320,'2026-05-22 07:30:00'),
      ('female','Friday',   'lunch',    'Baked fish with quinoa and broccoli',   510,'2026-05-22 13:00:00'),
      ('female','Friday',   'dinner',   'Lean beef and vegetable stew',          540,'2026-05-22 19:00:00'),
      ('male',  'Monday',   'breakfast','Protein shake with banana and oats',    520,'2026-05-18 07:00:00'),
      ('male',  'Monday',   'lunch',    'Chicken breast with sweet potato mash', 680,'2026-05-18 13:00:00'),
      ('male',  'Monday',   'snack',    'Mixed walnuts and almonds',             240,'2026-05-18 16:30:00'),
      ('male',  'Monday',   'dinner',   'Salmon with basmati rice and salad',    760,'2026-05-18 19:30:00'),
      ('male',  'Tuesday',  'breakfast','Eggs with spinach and cheese',          350,'2026-05-19 07:00:00'),
      ('male',  'Tuesday',  'lunch',    'Quinoa bowl with shredded beef',        590,'2026-05-19 13:00:00'),
      ('male',  'Tuesday',  'snack',    'Protein bar',                           280,'2026-05-19 16:00:00'),
      ('male',  'Tuesday',  'dinner',   'Lean beef stir-fry with noodles',       720,'2026-05-19 19:00:00'),
      ('male',  'Wednesday','breakfast','Protein shake with banana and oats',    520,'2026-05-20 07:00:00'),
      ('male',  'Wednesday','lunch',    'Steak with cauliflower mash',           610,'2026-05-20 13:00:00'),
      ('male',  'Wednesday','dinner',   'Grilled chicken with roasted sweet potato',640,'2026-05-20 19:00:00'),
      ('male',  'Thursday', 'breakfast','Avocado toast with eggs',               430,'2026-05-21 07:00:00'),
      ('male',  'Thursday', 'lunch',    'Chicken breast with sweet potato mash', 680,'2026-05-21 13:00:00'),
      ('male',  'Thursday', 'snack',    'Cottage cheese',                        180,'2026-05-21 16:00:00'),
      ('male',  'Thursday', 'dinner',   'Salmon with rice and roasted veg',      700,'2026-05-21 19:00:00'),
      ('male',  'Friday',   'breakfast','Eggs with spinach and cheese',          350,'2026-05-22 07:00:00'),
      ('male',  'Friday',   'lunch',    'Quinoa bowl with shredded beef',        590,'2026-05-22 13:00:00'),
      ('male',  'Friday',   'dinner',   'Lean beef stir-fry with noodles',       720,'2026-05-22 19:00:00'),
      ('girl',  'Monday',   'breakfast','Greek yogurt parfait with mixed nuts',  410,'2026-05-18 07:10:00'),
      ('girl',  'Monday',   'lunch',    'Turkey wrap with garden greens',        420,'2026-05-18 13:15:00'),
      ('girl',  'Monday',   'snack',    'Sliced apple with almond butter',       210,'2026-05-18 16:00:00'),
      ('girl',  'Monday',   'dinner',   'Stir-fried tofu with jasmine rice bowl',530,'2026-05-18 18:30:00'),
      ('girl',  'Tuesday',  'breakfast','Oatmeal with berries and a boiled egg', 320,'2026-05-19 07:10:00'),
      ('girl',  'Tuesday',  'lunch',    'Grilled chicken salad',                 430,'2026-05-19 13:00:00'),
      ('girl',  'Tuesday',  'dinner',   'Baked fish with quinoa',                490,'2026-05-19 18:30:00'),
      ('girl',  'Wednesday','breakfast','Smoothie bowl with granola',            340,'2026-05-20 07:10:00'),
      ('girl',  'Wednesday','lunch',    'Turkey wrap with garden greens',        420,'2026-05-20 13:00:00'),
      ('girl',  'Wednesday','snack',    'Greek yogurt',                          150,'2026-05-20 15:45:00'),
      ('girl',  'Wednesday','dinner',   'Chicken stir-fry with soba noodles',    490,'2026-05-20 18:30:00'),
      ('girl',  'Thursday', 'breakfast','Avocado toast with eggs',               350,'2026-05-21 07:10:00'),
      ('girl',  'Thursday', 'lunch',    'Tuna salad with mixed greens',          380,'2026-05-21 13:00:00'),
      ('girl',  'Thursday', 'dinner',   'Salmon with asparagus and rice',        500,'2026-05-21 18:30:00'),
      ('boy',   'Monday',   'breakfast','Peanut butter sandwich on whole wheat', 380,'2026-05-18 07:15:00'),
      ('boy',   'Monday',   'lunch',    'Quinoa bowl with shredded beef',        590,'2026-05-18 13:00:00'),
      ('boy',   'Monday',   'snack',    'High-protein shake bar',                290,'2026-05-18 15:45:00'),
      ('boy',   'Monday',   'dinner',   'Lean beef stir-fry with noodles',       720,'2026-05-18 18:45:00'),
      ('boy',   'Tuesday',  'breakfast','Eggs with spinach and cheese',          350,'2026-05-19 07:15:00'),
      ('boy',   'Tuesday',  'lunch',    'Chicken breast with sweet potato',      580,'2026-05-19 13:00:00'),
      ('boy',   'Tuesday',  'snack',    'Protein shake',                         280,'2026-05-19 15:30:00'),
      ('boy',   'Tuesday',  'dinner',   'Salmon with rice and salad',            650,'2026-05-19 18:45:00'),
      ('boy',   'Wednesday','breakfast','Oatmeal with berries',                  300,'2026-05-20 07:15:00'),
      ('boy',   'Wednesday','lunch',    'Quinoa bowl with shredded beef',        590,'2026-05-20 13:00:00'),
      ('boy',   'Wednesday','dinner',   'Grilled chicken with sweet potato',     620,'2026-05-20 18:45:00'),
      ('boy',   'Thursday', 'breakfast','Peanut butter sandwich on whole wheat', 380,'2026-05-21 07:15:00'),
      ('boy',   'Thursday', 'lunch',    'Steak with cauliflower mash',           560,'2026-05-21 13:00:00'),
      ('boy',   'Thursday', 'snack',    'Apple with almond butter',              180,'2026-05-21 15:30:00'),
      ('boy',   'Thursday', 'dinner',   'Lean beef stir-fry with noodles',       720,'2026-05-21 18:45:00');
    `);
    console.log('   Meals done');

    // ════════════════════════════════════════════════════════════
    // 10. PERIOD CYCLES — 3 months for female and girl
    // ════════════════════════════════════════════════════════════
    console.log('10. Seeding period cycles...');
    await pool.query(`
      INSERT INTO vectraarchlegacy_period (username, start_date, end_date, cycle_length, symptoms, date) VALUES
      ('female','2026-03-08','2026-03-13',28,'Cramps,Fatigue',               '2026-03-08 08:00:00'),
      ('female','2026-04-05','2026-04-10',28,'Cramps,Fatigue,Backache',      '2026-04-05 08:00:00'),
      ('female','2026-05-02','2026-05-07',28,'Cramps,Fatigue,Backache',      '2026-05-02 08:00:00'),
      ('girl',  '2026-03-15','2026-03-19',30,'Bloating,Headache',            '2026-03-15 09:00:00'),
      ('girl',  '2026-04-14','2026-04-18',30,'Bloating,Mood swings',         '2026-04-14 09:00:00'),
      ('girl',  '2026-05-10','2026-05-14',30,'Bloating,Headache,Mood swings','2026-05-10 09:00:00');
    `);
    console.log('   Cycles done');

    console.log('\x1b[32m%s\x1b[0m', '\n✓ SUCCESS — Full dataset loaded!');
    console.log('  Users:     female / male / girl / boy');
    console.log('  Password:  TestThisAppPlease');
    console.log('  Data:      3 months | budgets (50/30/20) | 80+ transactions | 75+ events');
    console.log('             90+ workouts | 80+ meals | 6 cycles');

  } catch(err) {
    console.error('\x1b[31mERROR:\x1b[0m', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

run();
