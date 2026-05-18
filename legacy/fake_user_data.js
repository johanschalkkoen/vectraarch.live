'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config({ path: '/var/www/vectraarch.live/forge/.env' });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: 'VectraArchLegacy',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
});

const passwordRaw = 'sqwl+kXXyyED7bgx';

async function rebuildAll() {
    try {
        console.log('1. Clearing all existing data...');
        await pool.query('TRUNCATE vectraarchlegacy_users, vectraarchlegacy_financial, vectraarchlegacy_budget, vectraarchlegacy_calendar, vectraarchlegacy_gymworkout, vectraarchlegacy_mealplan, vectraarchlegacy_period CASCADE;');

        console.log('2. Hashing password...');
        const hash = await bcrypt.hash(passwordRaw, 10);

        console.log('3. Creating the Koen Family Users...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_users
            (username, password_hash, first_name, last_name, display_name, email, phone, gender, event_color, is_admin, theme, dob, weight, height)
            VALUES
            ('female', $1, 'Femal',  'Koen', 'Mother (Female)', 'female@vectraarch.live', '0821112222', 'female', '#e91e8c', 1, 'dark', '1985-03-14', 62.5, 165),
            ('male',   $1, 'Male',   'Koen', 'Father (Male)',   'male@vectraarch.live',   '0823334444', 'male',   '#00e676', 0, 'dark', '1982-07-22', 88.0, 182),
            ('girl',   $1, 'Girl',   'Koen', 'Daughter (Girl)', 'girl@vectraarch.live',   '0825556666', 'female', '#e040fb', 0, 'dark', '2009-11-05', 52.0, 160),
            ('boy',    $1, 'Boy',    'Koen', 'Son (Boy)',       'boy@vectraarch.live',    '0827778888', 'male',   '#448aff', 0, 'dark', '2012-04-18', 45.0, 152);
        `, [hash]);

        console.log('4. Setting up partner access links...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_access (viewer, target) VALUES
            ('female', 'male'), ('male', 'female'),
            ('female', 'girl'), ('female', 'boy'),
            ('male',   'girl'), ('male',   'boy'),
            ('girl',   'female'), ('boy', 'male');
        `);

        console.log('5. Seeding 3 months of budgets...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_budget (username, income, expenses, date) VALUES
            -- March 2026
            ('female', 45000.00, '[{"category":"Main Groceries","amount":7800},{"category":"School Fees","amount":12000},{"category":"Medical Aid","amount":4500},{"category":"Household Misc","amount":3200}]', '2026-03-01'),
            ('male',   55000.00, '[{"category":"Standard Bank Bond","amount":18500},{"category":"Vehicle Finance","amount":11000},{"category":"Fuel","amount":5200},{"category":"Utilities","amount":5800},{"category":"Savings","amount":10000}]', '2026-03-01'),
            -- April 2026
            ('female', 45000.00, '[{"category":"Main Groceries","amount":8100},{"category":"School Fees","amount":12000},{"category":"Medical Aid","amount":4500},{"category":"Kids Activities","amount":2800}]', '2026-04-01'),
            ('male',   55000.00, '[{"category":"Standard Bank Bond","amount":18500},{"category":"Vehicle Finance","amount":11000},{"category":"Fuel","amount":5500},{"category":"Utilities","amount":6100},{"category":"Savings","amount":10000}]', '2026-04-01'),
            -- May 2026
            ('female', 47000.00, '[{"category":"Main Groceries","amount":8000},{"category":"School Fees & Kits","amount":12000},{"category":"Medical Aid","amount":4500},{"category":"Household Misc","amount":3500}]', '2026-05-01'),
            ('male',   58000.00, '[{"category":"Standard Bank Bond","amount":18500},{"category":"Vehicle Finance & Insurance","amount":11000},{"category":"Fuel Allocation","amount":5500},{"category":"Utilities & Fibre","amount":6000},{"category":"Savings & Investments","amount":12000}]', '2026-05-01');
        `);

        console.log('6. Seeding 3 months of financial transactions...');
        // ── MARCH ──
        await pool.query(`INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES
            ('female', 'Monthly Salary',              45000.00, 'income',  '2026-03-01 08:00:00'),
            ('male',   'Corporate Salary',            55000.00, 'income',  '2026-03-01 08:30:00'),
            ('male',   'Rental Income — Flatlet',      4200.00, 'income',  '2026-03-01 09:00:00'),
            ('male',   'Standard Bank Bond',          18500.00, 'expense', '2026-03-01 00:05:00'),
            ('female', 'Curro School Fees',            9500.00, 'expense', '2026-03-02 09:00:00'),
            ('female', 'Discovery Medical Aid',        4500.00, 'expense', '2026-03-02 10:15:00'),
            ('male',   'Wesbank Vehicle Payment',      8200.00, 'expense', '2026-03-03 04:30:00'),
            ('male',   'Utilities — Joburg City',      4100.00, 'expense', '2026-03-03 06:00:00'),
            ('male',   'Cool Ideas Fibre',              999.00, 'expense', '2026-03-04 02:00:00'),
            ('female', 'SuperSpar Groceries',          3200.00, 'expense', '2026-03-05 14:20:00'),
            ('male',   'Sasol Fuel',                   1100.00, 'expense', '2026-03-06 17:45:00'),
            ('female', 'Woolworths Food',              1050.00, 'expense', '2026-03-08 16:10:00'),
            ('male',   'Checkers Hyper',               2600.00, 'expense', '2026-03-10 11:15:00'),
            ('female', 'Dis-Chem Pharmacy',             620.00, 'expense', '2026-03-12 12:40:00'),
            ('male',   'Engen Fuel',                   1150.00, 'expense', '2026-03-13 08:15:00'),
            ('female', 'Mr Price Clothing',            1200.00, 'expense', '2026-03-14 15:30:00'),
            ('boy',    'Rugby Boots',                   780.00, 'expense', '2026-03-15 14:00:00'),
            ('girl',   'Netball Shoes',                 650.00, 'expense', '2026-03-15 14:30:00'),
            ('female', 'Pick n Pay Weekly',            1950.00, 'expense', '2026-03-17 11:30:00'),
            ('male',   'Takealot Tech Order',          2100.00, 'expense', '2026-03-18 10:20:00'),
            ('female', 'Apple iCloud Storage',          150.00, 'expense', '2026-03-27 02:00:00'),
            ('male',   'Family Weekend Braai',          890.00, 'expense', '2026-03-28 18:00:00'),
            ('male',   'Investment — EasyEquities',    5000.00, 'expense', '2026-03-28 09:00:00'),
            ('female', 'Bonus Payout Q1',              8500.00, 'income',  '2026-03-25 08:00:00');
        `);

        // ── APRIL ──
        await pool.query(`INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES
            ('female', 'Monthly Salary',              45000.00, 'income',  '2026-04-01 08:00:00'),
            ('male',   'Corporate Salary',            55000.00, 'income',  '2026-04-01 08:30:00'),
            ('male',   'Rental Income — Flatlet',      4200.00, 'income',  '2026-04-01 09:00:00'),
            ('male',   'Standard Bank Bond',          18500.00, 'expense', '2026-04-01 00:05:00'),
            ('female', 'Curro School Fees',            9500.00, 'expense', '2026-04-02 09:00:00'),
            ('female', 'Discovery Medical Aid',        4500.00, 'expense', '2026-04-02 10:15:00'),
            ('male',   'Wesbank Vehicle Payment',      8200.00, 'expense', '2026-04-03 04:30:00'),
            ('male',   'Utilities — Joburg City',      4400.00, 'expense', '2026-04-03 06:00:00'),
            ('male',   'Cool Ideas Fibre',              999.00, 'expense', '2026-04-04 02:00:00'),
            ('female', 'Spar Groceries Run',           3350.00, 'expense', '2026-04-04 14:00:00'),
            ('male',   'BP Fuel Refill',               1250.00, 'expense', '2026-04-06 07:30:00'),
            ('female', 'Woolworths Food',              1100.00, 'expense', '2026-04-08 16:00:00'),
            ('boy',    'Stationery & Art Supplies',    480.00,  'expense', '2026-04-09 10:00:00'),
            ('female', 'Clicks Health Products',       720.00,  'expense', '2026-04-10 13:00:00'),
            ('male',   'Checkers Grocery Haul',       2750.00,  'expense', '2026-04-12 11:00:00'),
            ('girl',   'Piano Sheet Music Books',      290.00,  'expense', '2026-04-14 16:00:00'),
            ('female', 'Pick n Pay Fresh Produce',    1800.00,  'expense', '2026-04-16 12:00:00'),
            ('male',   'Sasol Fuel Topup',            1300.00,  'expense', '2026-04-18 08:00:00'),
            ('male',   'Builders Warehouse DIY',      2200.00,  'expense', '2026-04-20 09:30:00'),
            ('female', 'Netball Tournament Catering',  650.00,  'expense', '2026-04-22 15:00:00'),
            ('male',   'Easter Family Lunch',         2100.00,  'expense', '2026-04-05 13:00:00'),
            ('female', 'Apple iCloud Storage',          150.00, 'expense', '2026-04-27 02:00:00'),
            ('male',   'Investment — EasyEquities',   5000.00,  'expense', '2026-04-28 09:00:00'),
            ('male',   'Freelance Consulting Fee',    7500.00,  'income',  '2026-04-15 10:00:00');
        `);

        // ── MAY ──
        await pool.query(`INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES
            ('female', 'Monthly Salary',              47000.00, 'income',  '2026-05-01 08:00:00'),
            ('male',   'Corporate Salary',            58000.00, 'income',  '2026-05-01 08:30:00'),
            ('male',   'Rental Income — Flatlet',      4200.00, 'income',  '2026-05-01 09:00:00'),
            ('male',   'Investment Dividend Return',   3150.00, 'income',  '2026-05-15 11:00:00'),
            ('male',   'Standard Bank Bond',          18500.00, 'expense', '2026-05-01 00:05:00'),
            ('female', 'Curro School Fees',            9500.00, 'expense', '2026-05-02 09:00:00'),
            ('female', 'Discovery Medical Aid',        4500.00, 'expense', '2026-05-02 10:15:00'),
            ('male',   'Wesbank Vehicle Payment',      8200.00, 'expense', '2026-05-03 04:30:00'),
            ('male',   'Utilities — Joburg City',      4100.00, 'expense', '2026-05-03 06:00:00'),
            ('male',   'Cool Ideas Fibre',              999.00, 'expense', '2026-05-04 02:00:00'),
            ('female', 'SuperSpar Groceries Stack',   3450.00,  'expense', '2026-05-03 14:20:00'),
            ('male',   'Sasol Fuel Refill',            1200.00, 'expense', '2026-05-05 17:45:00'),
            ('female', 'Woolworths Food Run',          1150.00, 'expense', '2026-05-07 16:10:00'),
            ('male',   'Checkers Hyper Bulk Buy',      2800.00, 'expense', '2026-05-10 11:15:00'),
            ('female', 'Dis-Chem Pharmacy',             680.00, 'expense', '2026-05-12 12:40:00'),
            ('male',   'Total Garage Fuel Topup',      1400.00, 'expense', '2026-05-13 08:15:00'),
            ('female', 'Mr Price Clothing — Kids',     1450.00, 'expense', '2026-05-14 15:30:00'),
            ('boy',    'School Rugby Socks & Shield',   320.00, 'expense', '2026-05-15 14:00:00'),
            ('female', 'Pick n Pay Weekly',            2100.00, 'expense', '2026-05-17 11:30:00'),
            ('male',   'Engen Fuel Station',           1350.00, 'expense', '2026-05-20 07:10:00'),
            ('female', 'Netball Team Kit',              850.00, 'expense', '2026-05-21 16:45:00'),
            ('male',   'Takealot Home Order',          1250.00, 'expense', '2026-05-22 10:20:00'),
            ('female', 'SuperSpar Mid-Month',          1890.00, 'expense', '2026-05-24 15:00:00'),
            ('male',   'BMW Service Settlement',       4200.00, 'expense', '2026-05-26 16:30:00'),
            ('female', 'Apple iCloud Storage',          150.00, 'expense', '2026-05-27 02:00:00'),
            ('male',   'Family Dinner at Compadre',    1650.00, 'expense', '2026-05-28 20:30:00'),
            ('male',   'Investment — EasyEquities',    5000.00, 'expense', '2026-05-28 09:00:00'),
            ('girl',   'Item Sold (Income)',            200.00, 'income',  '2026-05-18 10:00:00'),
            ('boy',    'Car Wash Hustle',               150.00, 'income',  '2026-05-24 11:00:00');
        `);

        console.log('7. Seeding 3 months of calendar events...');
        // Financial calendar sync — May
        await pool.query(`INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, amount, event_color) VALUES
            ('female', 'Monthly Salary (income)',           '2026-05-01 08:00:00', 1, 'income',  47000.00, '#00e676'),
            ('male',   'Corporate Salary (income)',         '2026-05-01 08:30:00', 1, 'income',  58000.00, '#00e676'),
            ('male',   'Standard Bank Bond (expense)',      '2026-05-01 00:05:00', 1, 'expense', 18500.00, '#ff3b3b'),
            ('female', 'Curro School Fees (expense)',       '2026-05-02 09:00:00', 1, 'expense',  9500.00, '#ff3b3b'),
            ('female', 'SuperSpar Groceries (expense)',     '2026-05-03 14:20:00', 1, 'expense',  3450.00, '#ff3b3b'),
            ('male',   'BMW Service Settlement (expense)',  '2026-05-26 16:30:00', 1, 'expense',  4200.00, '#ff3b3b'),
            ('male',   'Family Dinner Compadre (expense)',  '2026-05-28 20:30:00', 1, 'expense',  1650.00, '#ff3b3b'),
            ('girl',   'Item Sold (income)',                '2026-05-18 10:00:00', 1, 'income',    200.00, '#00e676');
        `);

        // Family schedule — March
        await pool.query(`INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
            ('female', 'Q1 Strategy Presentation',    '2026-03-02 09:00:00', 0, 'work',     '#448aff'),
            ('male',   'Annual Performance Review',   '2026-03-03 10:00:00', 0, 'work',     '#448aff'),
            ('girl',   'School Science Expo',         '2026-03-04 08:00:00', 0, 'work',     '#448aff'),
            ('boy',    'Junior Rugby Trials',         '2026-03-05 15:00:00', 0, 'social',   '#ff3b3b'),
            ('female', 'Yoga & Wellness Morning',     '2026-03-07 07:00:00', 0, 'health',   '#e91e8c'),
            ('male',   'Client Entertainment Lunch',  '2026-03-10 12:30:00', 0, 'social',   '#e040fb'),
            ('girl',   'Netball League Match',        '2026-03-11 15:00:00', 0, 'social',   '#e040fb'),
            ('female', 'Parent Teacher Meeting',      '2026-03-12 14:00:00', 0, 'personal', '#ffd600'),
            ('male',   'Golf Club Monthly Medal',     '2026-03-14 08:00:00', 0, 'social',   '#e040fb'),
            ('boy',    'Birthday Party — Friend',     '2026-03-15 14:00:00', 0, 'social',   '#ffd600'),
            ('female', 'Dermatologist Appointment',   '2026-03-17 11:00:00', 0, 'health',   '#e91e8c'),
            ('male',   'Property Inspection Viewing', '2026-03-19 10:00:00', 0, 'personal', '#ffd600'),
            ('girl',   'Piano Recital Grade 4',       '2026-03-20 17:00:00', 0, 'personal', '#ffd600'),
            ('female', 'Supplier Review Session',     '2026-03-23 09:00:00', 0, 'work',     '#448aff'),
            ('male',   'Family Braai — Koen Estate',  '2026-03-28 12:00:00', 0, 'social',   '#ff3b3b'),
            ('female', 'Financial Advisor Meeting',   '2026-03-30 10:00:00', 0, 'work',     '#448aff');
        `);

        // Family schedule — April
        await pool.query(`INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
            ('female', 'Board Ops Strategy Meeting',  '2026-04-01 09:00:00', 0, 'work',     '#448aff'),
            ('male',   'Squash League Quarter-Final', '2026-04-02 18:00:00', 0, 'social',   '#e040fb'),
            ('girl',   'Netball Semifinals',          '2026-04-03 15:00:00', 0, 'social',   '#e040fb'),
            ('boy',    'Cross Country School Race',   '2026-04-04 09:00:00', 0, 'social',   '#448aff'),
            ('female', 'Biokinetics Follow-up',       '2026-04-07 07:30:00', 0, 'health',   '#e91e8c'),
            ('male',   'Easter Family Road Trip',     '2026-04-05 08:00:00', 0, 'personal', '#ffd600'),
            ('female', 'Easter Sunday Church',        '2026-04-05 09:00:00', 0, 'personal', '#ffd600'),
            ('boy',    'Coding Camp Day 1',           '2026-04-07 09:00:00', 0, 'personal', '#448aff'),
            ('boy',    'Coding Camp Day 2',           '2026-04-08 09:00:00', 0, 'personal', '#448aff'),
            ('girl',   'Drama Club Rehearsal',        '2026-04-09 14:00:00', 0, 'personal', '#ffd600'),
            ('male',   'IT Security Workshop',        '2026-04-14 08:00:00', 0, 'work',     '#448aff'),
            ('female', 'Ophthalmologist Visit',       '2026-04-15 10:00:00', 0, 'health',   '#e91e8c'),
            ('girl',   'Maths Olympiad Round 1',      '2026-04-16 08:30:00', 0, 'work',     '#448aff'),
            ('male',   'Freelance Project Kickoff',   '2026-04-15 09:00:00', 0, 'work',     '#448aff'),
            ('female', 'Mid-Year School Planning',    '2026-04-22 08:30:00', 0, 'work',     '#448aff'),
            ('male',   'Home Renovation Planning',    '2026-04-24 10:00:00', 0, 'personal', '#ffd600'),
            ('boy',    'School Athletics Day',        '2026-04-25 09:00:00', 0, 'social',   '#ff3b3b'),
            ('girl',   'Year-End Netball Dinner',     '2026-04-28 18:30:00', 0, 'social',   '#e040fb'),
            ('female', 'Wellness & Pilates Session',  '2026-04-30 07:00:00', 0, 'health',   '#e91e8c');
        `);

        // Family schedule — May
        await pool.query(`INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, event_color) VALUES
            ('female', 'EXCO Strategy Framework',     '2026-05-04 09:00:00', 0, 'work',     '#448aff'),
            ('male',   'Regional Operations Sync',    '2026-05-05 10:00:00', 0, 'work',     '#448aff'),
            ('girl',   'Netball Trials Group A',      '2026-05-05 15:00:00', 0, 'social',   '#e040fb'),
            ('boy',    'Under-13 Rugby Trials',       '2026-05-06 15:30:00', 0, 'social',   '#448aff'),
            ('female', 'Biokinetics Assessment',      '2026-05-07 07:30:00', 0, 'health',   '#e91e8c'),
            ('male',   'Quarterly Financial Audit',   '2026-05-11 11:00:00', 0, 'work',     '#448aff'),
            ('girl',   'Piano Grade 4 Evaluation',    '2026-05-12 16:00:00', 0, 'personal', '#ffd600'),
            ('boy',    'Science Tuition Clinic',      '2026-05-13 14:30:00', 0, 'work',     '#448aff'),
            ('female', 'Pediatric Checkup Kids',      '2026-05-14 14:00:00', 0, 'health',   '#e91e8c'),
            ('male',   'Squash Match vs Dave',        '2026-05-15 17:15:00', 0, 'social',   '#e040fb'),
            ('female', 'Project Kickoff Meeting',     '2026-05-18 09:00:00', 0, 'work',     '#448aff'),
            ('girl',   'Netball Practice',            '2026-05-18 15:30:00', 0, 'social',   '#e040fb'),
            ('male',   'Car Service BMW',             '2026-05-19 07:30:00', 0, 'personal', '#ffd600'),
            ('female', 'Dentist Appointment',         '2026-05-20 14:00:00', 0, 'health',   '#e91e8c'),
            ('boy',    'Primary School Rugby Match',  '2026-05-20 16:00:00', 0, 'social',   '#448aff'),
            ('girl',   'Maths Term Test',             '2026-05-21 08:30:00', 0, 'work',     '#448aff'),
            ('male',   'Golf Day with Clients',       '2026-05-22 12:00:00', 0, 'social',   '#e040fb'),
            ('boy',    'Guitar Lesson',               '2026-05-22 15:00:00', 0, 'personal', '#ffd600'),
            ('female', 'Supplier Contract Signoff',   '2026-05-25 10:30:00', 0, 'work',     '#448aff'),
            ('male',   'IT Infrastructure Board',     '2026-05-26 14:00:00', 0, 'work',     '#448aff'),
            ('boy',    'Rugby Semi-Final Clash',      '2026-05-27 15:30:00', 0, 'social',   '#ff3b3b'),
            ('girl',   'Netball Season Finale',       '2026-05-28 14:00:00', 0, 'social',   '#ffd600'),
            ('male',   'Wedding Anniversary Dinner',  '2026-05-29 19:00:00', 0, 'social',   '#e91e8c'),
            ('female', 'Wellness Day Retreat',        '2026-05-30 09:00:00', 0, 'health',   '#e91e8c'),
            ('boy',    'End-of-Term Celebration',     '2026-05-29 14:00:00', 0, 'social',   '#448aff');
        `);

        console.log('8. Seeding 3 months of gym workouts...');
        // MARCH workouts
        await pool.query(`INSERT INTO vectraarchlegacy_gymworkout (username, day, exercise, sets, reps, weight, date) VALUES
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '45',      '2026-03-02 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'vinyasa', '2026-03-04 06:15:00'),
            ('female', 'Friday',    'Lat Pulldown',                          3, '12', '30',      '2026-03-06 06:00:00'),
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '47.5',   '2026-03-09 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'vinyasa', '2026-03-11 06:15:00'),
            ('female', 'Friday',    'Dumbbell Romanian Deadlift',            3, '10', '22',      '2026-03-13 06:00:00'),
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '47.5',   '2026-03-16 06:00:00'),
            ('female', 'Wednesday', 'Pilates Core Flow',                     1, '45', 'bodyweight','2026-03-18 06:15:00'),
            ('female', 'Monday',    'Goblet Squat',                          3, '12', '16',      '2026-03-23 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'power',   '2026-03-25 06:15:00'),
            ('female', 'Friday',    'Cable Row',                             3, '12', '28',      '2026-03-27 06:00:00'),

            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '75',      '2026-03-02 17:30:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '40', '5.8',     '2026-03-03 18:00:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      3, '5',  '110',     '2026-03-05 17:30:00'),
            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '80',      '2026-03-09 17:30:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '40', '6.0',     '2026-03-10 18:00:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      3, '5',  '112.5',   '2026-03-12 17:30:00'),
            ('male',   'Saturday',  'Dumbbell Bicep Curl',                   3, '12', '14',      '2026-03-14 09:00:00'),
            ('male',   'Monday',    'Overhead Press',                        3, '8',  '60',      '2026-03-16 17:30:00'),
            ('male',   'Thursday',  'Romanian Deadlift',                     3, '10', '80',      '2026-03-19 17:30:00'),
            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '82.5',    '2026-03-23 17:30:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '45', '6.2',     '2026-03-24 18:00:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      4, '5',  '115',     '2026-03-26 17:30:00'),
            ('male',   'Saturday',  'Dumbbell Bicep Curl',                   3, '12', '16',      '2026-03-28 09:00:00'),

            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '25', '3.8',     '2026-03-03 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     3, '12', '0',       '2026-03-05 16:00:00'),
            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '28', '4.0',     '2026-03-10 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     3, '15', '0',       '2026-03-12 16:00:00'),
            ('girl',   'Tuesday',   'Interval sprints',                      1, '20', '3.5',     '2026-03-17 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     3, '15', '0',       '2026-03-19 16:00:00'),
            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '30', '4.2',     '2026-03-24 15:30:00'),

            ('boy',    'Wednesday', 'Interval sprints',                      1, '15', '2.5',     '2026-03-04 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '8',  '0',       '2026-03-06 07:00:00'),
            ('boy',    'Wednesday', 'Interval sprints',                      1, '18', '2.8',     '2026-03-11 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '10', '0',       '2026-03-13 07:00:00'),
            ('boy',    'Wednesday', 'Interval sprints',                      1, '20', '3.0',     '2026-03-18 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '12', '0',       '2026-03-20 07:00:00');
        `);

        // APRIL & MAY workouts
        await pool.query(`INSERT INTO vectraarchlegacy_gymworkout (username, day, exercise, sets, reps, weight, date) VALUES
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '47.5',    '2026-04-06 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'vinyasa',  '2026-04-08 06:15:00'),
            ('female', 'Friday',    'Lat Pulldown',                          3, '12', '32',       '2026-04-10 06:00:00'),
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '50',      '2026-04-13 06:00:00'),
            ('female', 'Wednesday', 'Pilates Core',                          1, '45', 'bodyweight','2026-04-15 06:15:00'),
            ('female', 'Monday',    'Goblet Squat',                          3, '12', '18',       '2026-04-20 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'power ash', '2026-04-22 06:15:00'),
            ('female', 'Friday',    'Dumbbell Romanian Deadlift',            3, '10', '24',       '2026-04-24 06:00:00'),

            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '82.5',    '2026-04-06 17:30:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '40', '6.3',     '2026-04-07 18:00:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      3, '5',  '117.5',   '2026-04-09 17:30:00'),
            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '85',      '2026-04-13 17:30:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      4, '5',  '120',     '2026-04-16 17:30:00'),
            ('male',   'Saturday',  'Dumbbell Bicep Curl',                   3, '12', '16',      '2026-04-18 09:00:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '45', '6.5',     '2026-04-21 18:00:00'),
            ('male',   'Monday',    'Overhead Press',                        4, '8',  '62.5',    '2026-04-27 17:30:00'),

            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '30', '4.2',     '2026-04-07 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     3, '15', '0',       '2026-04-09 16:00:00'),
            ('girl',   'Tuesday',   'Interval sprints',                      1, '22', '4.0',     '2026-04-14 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     4, '15', '0',       '2026-04-16 16:00:00'),
            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '32', '4.5',     '2026-04-21 15:30:00'),

            ('boy',    'Wednesday', 'Interval sprints',                      1, '20', '3.2',     '2026-04-08 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '12', '0',       '2026-04-10 07:00:00'),
            ('boy',    'Wednesday', 'Interval sprints',                      1, '22', '3.5',     '2026-04-15 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '15', '0',       '2026-04-17 07:00:00'),

            -- MAY
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '50',      '2026-05-04 06:00:00'),
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '52.5',    '2026-05-11 06:00:00'),
            ('female', 'Monday',    'Barbell Back Squat',                     3, '10', '55',      '2026-05-18 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'vinyasa',  '2026-05-06 06:15:00'),
            ('female', 'Wednesday', 'Yoga Flow',                             1, '45', 'power ash','2026-05-20 06:15:00'),
            ('female', 'Friday',    'Lat Pulldown',                          3, '12', '35',       '2026-05-22 06:00:00'),
            ('female', 'Friday',    'Cable Row',                             3, '12', '30',       '2026-05-08 06:00:00'),
            ('female', 'Wednesday', 'Pilates Core',                          1, '45', 'bodyweight','2026-05-13 06:15:00'),

            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '85',      '2026-05-04 17:30:00'),
            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '87.5',    '2026-05-11 17:30:00'),
            ('male',   'Monday',    'Barbell Bench Press',                   4, '8',  '90',      '2026-05-18 17:30:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '40', '6.2',     '2026-05-05 18:00:00'),
            ('male',   'Tuesday',   'Run · Zone 2',                          1, '45', '6.5',     '2026-05-19 18:00:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      3, '5',  '120',     '2026-05-07 17:30:00'),
            ('male',   'Thursday',  'Barbell Deadlift',                      4, '5',  '122.5',   '2026-05-21 17:30:00'),
            ('male',   'Saturday',  'Dumbbell Bicep Curl',                   3, '12', '16',      '2026-05-09 09:00:00'),
            ('male',   'Saturday',  'Dumbbell Bicep Curl',                   3, '12', '18',      '2026-05-23 09:00:00'),
            ('male',   'Thursday',  'Overhead Press',                        4, '8',  '65',      '2026-05-14 17:30:00'),
            ('male',   'Saturday',  'Pull-Ups',                              3, '8',  'bodyweight','2026-05-16 09:00:00'),

            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '30', '4.2',     '2026-05-05 15:30:00'),
            ('girl',   'Tuesday',   'Steady-state running or jogging',       1, '35', '4.8',     '2026-05-19 15:30:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     3, '15', '0',       '2026-05-07 16:00:00'),
            ('girl',   'Thursday',  'Bodyweight Squats',                     4, '15', '0',       '2026-05-21 16:00:00'),
            ('girl',   'Tuesday',   'Interval sprints',                      1, '25', '5.0',     '2026-05-12 15:30:00'),
            ('girl',   'Thursday',  'Dumbbell Hip Thrust',                   3, '12', '10',      '2026-05-14 16:00:00'),

            ('boy',    'Wednesday', 'Interval sprints',                      1, '20', '3.0',     '2026-05-06 15:00:00'),
            ('boy',    'Wednesday', 'Interval sprints',                      1, '22', '3.5',     '2026-05-20 15:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '10', '0',       '2026-05-08 07:00:00'),
            ('boy',    'Friday',    'Push-Ups (standard, wide, diamond)',    3, '15', '0',       '2026-05-22 07:00:00'),
            ('boy',    'Wednesday', 'Broad Jumps',                           3, '8',  '0',       '2026-05-13 15:00:00'),
            ('boy',    'Friday',    'Dumbbell Shoulder Press',               3, '10', '8',       '2026-05-15 07:00:00');
        `);

        console.log('9. Seeding 3 months of meal plans...');
        // MARCH meals (weekdays)
        await pool.query(`INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date) VALUES
            ('female', 'Monday',    'breakfast', 'Oatmeal with berries and a boiled egg',          320, '2026-03-02 07:30:00'),
            ('female', 'Monday',    'lunch',     'Grilled chicken salad with veggies',             450, '2026-03-02 13:00:00'),
            ('female', 'Monday',    'dinner',    'Baked fish with quinoa and broccoli',            510, '2026-03-02 19:00:00'),
            ('female', 'Wednesday', 'breakfast', 'Avocado toast with eggs',                        380, '2026-03-04 07:30:00'),
            ('female', 'Wednesday', 'lunch',     'Turkey wrap with garden greens',                 420, '2026-03-04 13:00:00'),
            ('female', 'Wednesday', 'dinner',    'Stir-fried tofu with jasmine rice bowl',         480, '2026-03-04 19:00:00'),
            ('female', 'Friday',    'breakfast', 'Greek yogurt parfait with mixed nuts',           410, '2026-03-06 07:30:00'),
            ('female', 'Friday',    'lunch',     'Tuna salad with mixed greens',                   380, '2026-03-06 13:00:00'),
            ('female', 'Friday',    'dinner',    'Salmon with basmati rice and roasted salad',     520, '2026-03-06 19:00:00'),

            ('male',   'Monday',    'breakfast', 'Protein shake with banana and oats',             520, '2026-03-02 07:00:00'),
            ('male',   'Monday',    'lunch',     'Chicken breast with sweet potato mash',          680, '2026-03-02 13:00:00'),
            ('male',   'Monday',    'dinner',    'Lean beef stir-fry with brown egg noodles',      720, '2026-03-02 19:00:00'),
            ('male',   'Tuesday',   'breakfast', 'Eggs with spinach and cheese',                   350, '2026-03-03 07:00:00'),
            ('male',   'Tuesday',   'lunch',     'Quinoa bowl with shredded beef',                 590, '2026-03-03 13:00:00'),
            ('male',   'Thursday',  'breakfast', 'Protein shake with banana and oats',             520, '2026-03-05 07:00:00'),
            ('male',   'Thursday',  'lunch',     'Steak with cauliflower mash',                    610, '2026-03-05 13:00:00'),
            ('male',   'Thursday',  'dinner',    'Salmon with rice and roasted veg',               700, '2026-03-05 19:00:00'),

            ('girl',   'Monday',    'breakfast', 'Greek yogurt parfait with mixed nuts',           410, '2026-03-02 07:10:00'),
            ('girl',   'Monday',    'lunch',     'Turkey wrap with garden greens',                 420, '2026-03-02 13:00:00'),
            ('girl',   'Monday',    'dinner',    'Stir-fried tofu with jasmine rice bowl',         530, '2026-03-02 18:30:00'),
            ('girl',   'Wednesday', 'breakfast', 'Oatmeal with berries and a boiled egg',          320, '2026-03-04 07:10:00'),
            ('girl',   'Wednesday', 'lunch',     'Tuna salad with mixed greens',                   380, '2026-03-04 13:00:00'),

            ('boy',    'Monday',    'breakfast', 'Peanut butter sandwich on whole wheat',          380, '2026-03-02 07:15:00'),
            ('boy',    'Monday',    'lunch',     'Quinoa bowl with shredded beef',                 590, '2026-03-02 13:00:00'),
            ('boy',    'Monday',    'dinner',    'Lean beef stir-fry with brown egg noodles',      720, '2026-03-02 18:45:00'),
            ('boy',    'Wednesday', 'breakfast', 'Eggs with spinach and cheese',                   350, '2026-03-04 07:15:00'),
            ('boy',    'Wednesday', 'lunch',     'Chicken breast with sweet potato mash',          580, '2026-03-04 13:00:00');
        `);

        // MAY meals (richer dataset — multiple days)
        await pool.query(`INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date) VALUES
            ('female', 'Monday',    'breakfast', 'Oatmeal with berries and a boiled egg',          320, '2026-05-18 07:30:00'),
            ('female', 'Monday',    'lunch',     'Grilled chicken salad with veggies',             450, '2026-05-18 13:00:00'),
            ('female', 'Monday',    'snack',     'Greek yogurt with raw honey',                    160, '2026-05-18 16:15:00'),
            ('female', 'Monday',    'dinner',    'Baked fish with quinoa and broccoli',            510, '2026-05-18 19:15:00'),
            ('female', 'Tuesday',   'breakfast', 'Avocado toast with poached eggs',                390, '2026-05-19 07:30:00'),
            ('female', 'Tuesday',   'lunch',     'Tuna salad with mixed greens',                   380, '2026-05-19 13:00:00'),
            ('female', 'Tuesday',   'dinner',    'Chicken stir-fry with soba noodles',             490, '2026-05-19 19:00:00'),
            ('female', 'Wednesday', 'breakfast', 'Smoothie bowl with granola',                     340, '2026-05-20 07:30:00'),
            ('female', 'Wednesday', 'lunch',     'Turkey wrap with garden greens',                 420, '2026-05-20 13:00:00'),
            ('female', 'Wednesday', 'snack',     'Sliced apple with almond butter',                180, '2026-05-20 16:00:00'),
            ('female', 'Wednesday', 'dinner',    'Salmon with asparagus and lemon rice',           540, '2026-05-20 19:00:00'),
            ('female', 'Thursday',  'breakfast', 'Greek yogurt parfait with mixed nuts',           410, '2026-05-21 07:30:00'),
            ('female', 'Thursday',  'lunch',     'Grilled chicken salad with veggies',             450, '2026-05-21 13:00:00'),
            ('female', 'Thursday',  'dinner',    'Stir-fried tofu with jasmine rice bowl',         480, '2026-05-21 19:00:00'),
            ('female', 'Friday',    'breakfast', 'Oatmeal with berries and a boiled egg',          320, '2026-05-22 07:30:00'),
            ('female', 'Friday',    'lunch',     'Baked fish with quinoa and broccoli',            510, '2026-05-22 13:00:00'),
            ('female', 'Friday',    'dinner',    'Lean beef and vegetable stew',                   540, '2026-05-22 19:00:00'),

            ('male',   'Monday',    'breakfast', 'Protein shake with banana and oats',             520, '2026-05-18 07:00:00'),
            ('male',   'Monday',    'lunch',     'Chicken breast with sweet potato mash',          680, '2026-05-18 13:00:00'),
            ('male',   'Monday',    'snack',     'Mixed walnuts and almonds',                      240, '2026-05-18 16:30:00'),
            ('male',   'Monday',    'dinner',    'Salmon with basmati rice and roasted salad',     760, '2026-05-18 19:30:00'),
            ('male',   'Tuesday',   'breakfast', 'Eggs with spinach and cheese',                   350, '2026-05-19 07:00:00'),
            ('male',   'Tuesday',   'lunch',     'Quinoa bowl with shredded beef',                 590, '2026-05-19 13:00:00'),
            ('male',   'Tuesday',   'snack',     'Protein bar',                                    280, '2026-05-19 16:00:00'),
            ('male',   'Tuesday',   'dinner',    'Lean beef stir-fry with brown noodles',         720, '2026-05-19 19:00:00'),
            ('male',   'Wednesday', 'breakfast', 'Protein shake with banana and oats',             520, '2026-05-20 07:00:00'),
            ('male',   'Wednesday', 'lunch',     'Steak with cauliflower mash',                    610, '2026-05-20 13:00:00'),
            ('male',   'Wednesday', 'dinner',    'Grilled chicken with roasted sweet potato',      640, '2026-05-20 19:00:00'),
            ('male',   'Thursday',  'breakfast', 'Avocado toast with eggs',                        430, '2026-05-21 07:00:00'),
            ('male',   'Thursday',  'lunch',     'Chicken breast with sweet potato mash',          680, '2026-05-21 13:00:00'),
            ('male',   'Thursday',  'snack',     'Cottage cheese',                                 180, '2026-05-21 16:00:00'),
            ('male',   'Thursday',  'dinner',    'Salmon with rice and roasted veg',               700, '2026-05-21 19:00:00'),

            ('girl',   'Monday',    'breakfast', 'Greek yogurt parfait with mixed nuts',           410, '2026-05-18 07:10:00'),
            ('girl',   'Monday',    'lunch',     'Turkey wrap with garden greens',                 420, '2026-05-18 13:15:00'),
            ('girl',   'Monday',    'snack',     'Sliced apple with almond butter',                210, '2026-05-18 16:00:00'),
            ('girl',   'Monday',    'dinner',    'Stir-fried tofu with jasmine rice bowl',         530, '2026-05-18 18:30:00'),
            ('girl',   'Tuesday',   'breakfast', 'Oatmeal with berries and a boiled egg',          320, '2026-05-19 07:10:00'),
            ('girl',   'Tuesday',   'lunch',     'Grilled chicken salad',                          430, '2026-05-19 13:00:00'),
            ('girl',   'Tuesday',   'dinner',    'Baked fish with quinoa',                         490, '2026-05-19 18:30:00'),
            ('girl',   'Wednesday', 'breakfast', 'Smoothie bowl with granola',                     340, '2026-05-20 07:10:00'),
            ('girl',   'Wednesday', 'lunch',     'Turkey wrap with garden greens',                 420, '2026-05-20 13:00:00'),
            ('girl',   'Wednesday', 'snack',     'Greek yogurt',                                   150, '2026-05-20 15:45:00'),
            ('girl',   'Wednesday', 'dinner',    'Chicken stir-fry with soba noodles',             490, '2026-05-20 18:30:00'),

            ('boy',    'Monday',    'breakfast', 'Peanut butter sandwich on whole wheat',          380, '2026-05-18 07:15:00'),
            ('boy',    'Monday',    'lunch',     'Quinoa bowl with shredded beef',                 590, '2026-05-18 13:00:00'),
            ('boy',    'Monday',    'snack',     'High-protein shake bar',                         290, '2026-05-18 15:45:00'),
            ('boy',    'Monday',    'dinner',    'Lean beef stir-fry with brown noodles',         720, '2026-05-18 18:45:00'),
            ('boy',    'Tuesday',   'breakfast', 'Eggs with spinach and cheese',                   350, '2026-05-19 07:15:00'),
            ('boy',    'Tuesday',   'lunch',     'Chicken breast with sweet potato',               580, '2026-05-19 13:00:00'),
            ('boy',    'Tuesday',   'snack',     'Protein shake',                                  280, '2026-05-19 15:30:00'),
            ('boy',    'Tuesday',   'dinner',    'Salmon with rice and salad',                     650, '2026-05-19 18:45:00'),
            ('boy',    'Wednesday', 'breakfast', 'Oatmeal with berries',                           300, '2026-05-20 07:15:00'),
            ('boy',    'Wednesday', 'lunch',     'Quinoa bowl with shredded beef',                 590, '2026-05-20 13:00:00'),
            ('boy',    'Wednesday', 'dinner',    'Grilled chicken with roasted sweet potato',      620, '2026-05-20 18:45:00');
        `);

        console.log('10. Seeding period cycles for female and girl...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_period (username, start_date, end_date, cycle_length, symptoms, date) VALUES
            -- Mother: 3 cycles (March, April, May)
            ('female', '2026-03-08', '2026-03-13', 28, 'Cramps,Fatigue',                  '2026-03-08 08:00:00'),
            ('female', '2026-04-05', '2026-04-10', 28, 'Cramps,Fatigue,Backache',          '2026-04-05 08:00:00'),
            ('female', '2026-05-02', '2026-05-07', 28, 'Cramps,Fatigue,Backache',          '2026-05-02 08:00:00'),
            -- Daughter: 3 cycles (varied length)
            ('girl',   '2026-03-15', '2026-03-19', 30, 'Bloating,Headache',                '2026-03-15 09:00:00'),
            ('girl',   '2026-04-14', '2026-04-18', 30, 'Bloating,Mood swings',             '2026-04-14 09:00:00'),
            ('girl',   '2026-05-10', '2026-05-14', 30, 'Bloating,Headache,Mood swings',    '2026-05-10 09:00:00');
        `);

        console.log('\x1b[32m%s\x1b[0m', '\nSUCCESS: Full 3-month dataset loaded for all 4 Koen family members!');
        console.log('Users: female / male / girl / boy — all password: sqwl+kXXyyED7bgx');
        console.log('Data: 3 months budgets, 80+ transactions, 50+ events, 80+ workouts, 80+ meals, 6 cycles');
    } catch (err) {
        console.error('\x1b[31m%s\x1b[0m', 'ERROR:', err.message);
        console.error(err.stack);
    } finally {
        await pool.end();
    }
}

rebuildAll();
