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
        console.log('1. Cleaving any residual database tables...');
        await pool.query('TRUNCATE vectraarchlegacy_users, vectraarchlegacy_financial, vectraarchlegacy_budget, vectraarchlegacy_calendar, vectraarchlegacy_gymworkout, vectraarchlegacy_mealplan, vectraarchlegacy_period CASCADE;');

        console.log('2. Encrypting system password with local bcrypt profile...');
        const hash = await bcrypt.hash(passwordRaw, 10);

        console.log('3. Inserting the Koen Family Users...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_users 
            (username, password_hash, first_name, last_name, display_name, email, phone, gender, event_color, is_admin, theme)
            VALUES
            ('female', $1, 'Femal', 'Koen', 'Mother (Female)', 'female@vectraarch.live', '0821112222', 'female', '#e91e8c', 1, 'dark'),
            ('male', $1, 'Male', 'Koen', 'Father (Male)', 'male@vectraarch.live', '0823334444', 'male', '#00e676', 0, 'dark'),
            ('girl', $1, 'Girl', 'Koen', 'Daughter (Girl)', 'girl@vectraarch.live', '0825556666', 'female', '#e040fb', 0, 'dark'),
            ('boy', $1, 'Boy', 'Koen', 'Son (Boy)', 'boy@vectraarch.live', '0827778888', 'male', '#448aff', 0, 'dark');
        `, [hash]);

        console.log('4. Establishing cross-access permissions (Partner Sharing)...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_access (viewer, target) VALUES
            ('female', 'male'), ('male', 'female'),
            ('female', 'girl'), ('female', 'boy'),
            ('male', 'girl'), ('male', 'boy');
        `);

        console.log('5. Provisioning Granular Household Budgets...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_budget (username, income, expenses, date) VALUES
            ('female', 45000.00, '[{"category": "Main Groceries", "amount": 8000.00}, {"category": "School Fees & Kits", "amount": 12000.00}, {"category": "Medical Aid Sub", "amount": 4500.00}, {"category": "Household Miscellaneous", "amount": 3500.00}]', '2026-05-01'),
            ('male', 55000.00, '[{"category": "Standard Bank Bond", "amount": 18500.00}, {"category": "Vehicle Fin & Insure", "amount": 11000.00}, {"category": "Fuel Allocation", "amount": 5500.00}, {"category": "Utilities & Fibre", "amount": 6000.00}, {"category": "Savings & Investments", "amount": 10000.00}]', '2026-05-01');
        `);

        console.log('6. Seeding High-Density Financial Ledger & Syncing Calendar Entries...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_financial (username, category, amount, type, date) VALUES
            -- Salaries
            ('female', 'Monthly Salary', 45000.00, 'income', '2026-05-01 08:00:00'),
            ('male', 'Corporate Salary', 55000.00, 'income', '2026-05-01 08:30:00'),
            ('male', 'Investment Dividend Return', 3150.00, 'income', '2026-05-15 11:00:00'),
            
            -- Fixed Household Costs
            ('male', 'Standard Bank Bond', 18500.00, 'expense', '2026-05-01 00:05:00'),
            ('female', 'Curro School Fees', 9500.00, 'expense', '2026-05-02 09:00:00'),
            ('female', 'Discovery Health Medical Aid', 4500.00, 'expense', '2026-05-02 10:15:00'),
            ('male', 'Wesbank Vehicle Payment', 8200.00, 'expense', '2026-05-03 04:30:00'),
            ('male', 'City of Johannesburg Utilities', 4100.00, 'expense', '2026-05-03 06:00:00'),
            ('male', 'Cool Ideas Fibre Line', 999.00, 'expense', '2026-05-04 02:00:00'),
            
            -- Dynamic Expenses (Week 1 & 2)
            ('female', 'SuperSpar Groceries Stack', 3450.00, 'expense', '2026-05-03 14:20:00'),
            ('male', 'Sasol Fuel Refill', 1200.00, 'expense', '2026-05-05 17:45:00'),
            ('female', 'Woolworths Food Run', 1150.00, 'expense', '2026-05-07 16:10:00'),
            ('male', 'Checkers Hyper Bulk Buy', 2800.00, 'expense', '2026-05-10 11:15:00'),
            ('female', 'Dis-Chem Pharmacy Essentials', 680.00, 'expense', '2026-05-12 12:40:00'),
            ('male', 'Total Garage Fuel Topup', 1400.00, 'expense', '2026-05-13 08:15:00'),
            ('female', 'Mr Price Clothing - Kids Gear', 1450.00, 'expense', '2026-05-14 15:30:00'),
            ('boy', 'School Rugby Socks & Shield', 320.00, 'expense', '2026-05-15 14:00:00'),
            
            -- Dynamic Expenses (Week 3 & 4)
            ('female', 'Pick n Pay Weekly Food', 2100.00, 'expense', '2026-05-17 11:30:00'),
            ('male', 'Engen Fuel Station', 1350.00, 'expense', '2026-05-20 07:10:00'),
            ('female', 'Netball Team Kit Contribution', 850.00, 'expense', '2026-05-21 16:45:00'),
            ('male', 'Takealot Home Order', 1250.00, 'expense', '2026-05-22 10:20:00'),
            ('female', 'SuperSpar Mid-month Fill', 1890.00, 'expense', '2026-05-24 15:00:00'),
            ('male', 'BMW Service Settlement', 4200.00, 'expense', '2026-05-26 16:30:00'),
            ('female', 'Apple.com/Bill iCloud Storage', 150.00, 'expense', '2026-05-27 02:00:00'),
            ('male', 'Family Dinner at Compadre', 1650.00, 'expense', '2026-05-28 20:30:00');
        `);

        await pool.query(`
            INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, amount, event_color) VALUES
            ('female', 'Monthly Salary (income)', '2026-05-01 08:00:00', 1, 'income', 45000.00, '#00e676'),
            ('male', 'Corporate Salary (income)', '2026-05-01 08:30:00', 1, 'income', 55000.00, '#00e676'),
            ('male', 'Standard Bank Bond (expense)', '2026-05-01 00:05:00', 1, 'expense', 18500.00, '#ff3b3b'),
            ('female', 'Curro School Fees (expense)', '2026-05-02 09:00:00', 1, 'expense', 9500.00, '#ff3b3b'),
            ('female', 'SuperSpar Groceries Stack (expense)', '2026-05-03 14:20:00', 1, 'expense', 3450.00, '#ff3b3b'),
            ('male', 'BMW Service Settlement (expense)', '2026-05-26 16:30:00', 1, 'expense', 4200.00, '#ff3b3b'),
            ('male', 'Family Dinner at Compadre (expense)', '2026-05-28 20:30:00', 1, 'expense', 1650.00, '#ff3b3b');
        `);

        console.log('7. Seeding Exhaustive Family Constellation Schedules...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_calendar (username, title, date, is_financial, type, amount, event_color) VALUES
            -- Week 1
            ('female', 'EXCO Strategy Framework Review', '2026-05-04 09:00:00', 0, 'work', NULL, '#448aff'),
            ('male', 'Regional Operations Sync', '2026-05-05 10:00:00', 0, 'work', NULL, '#448aff'),
            ('girl', 'Netball Trials Group A', '2026-05-05 15:00:00', 0, 'social', NULL, '#e040fb'),
            ('boy', 'Under-13 Rugby Trials Phase 1', '2026-05-06 15:30:00', 0, 'social', NULL, '#448aff'),
            ('female', 'Biokinetics Baseline Assessment', '2026-05-07 07:30:00', 0, 'health', NULL, '#e91e8c'),
            
            -- Week 2
            ('male', 'Quarterly Financial Audit', '2026-05-11 11:00:00', 0, 'work', NULL, '#448aff'),
            ('girl', 'Piano Grade 4 Scale Evaluation', '2026-05-12 16:00:00', 0, 'personal', NULL, '#ffd600'),
            ('boy', 'Extra Science Tuition Clinic', '2026-05-13 14:30:00', 0, 'work', NULL, '#448aff'),
            ('female', 'Pediatric Checkup (Both Kids)', '2026-05-14 14:00:00', 0, 'health', NULL, '#e91e8c'),
            ('male', 'Squash Match vs Dave', '2026-05-15 17:15:00', 0, 'social', NULL, '#e040fb'),
            
            -- Week 3 (Current Focus Window)
            ('female', 'Project Kickoff Meeting', '2026-05-18 09:00:00', 0, 'work', NULL, '#448aff'),
            ('girl', 'Netball Practice Maturation', '2026-05-18 15:30:00', 0, 'social', NULL, '#e040fb'),
            ('male', 'Car Service @ BMW', '2026-05-19 07:30:00', 0, 'personal', NULL, '#ffd600'),
            ('female', 'Dentist Appointment', '2026-05-20 14:00:00', 0, 'health', NULL, '#e91e8c'),
            ('boy', 'Primary School Rugby Match', '2026-05-20 16:00:00', 0, 'social', NULL, '#448aff'),
            ('girl', 'Maths Term Test', '2026-05-21 08:30:00', 0, 'work', NULL, '#448aff'),
            ('male', 'Golf Day with Clients', '2026-05-22 12:00:00', 0, 'social', NULL, '#e040fb'),
            ('boy', 'Guitar Lesson', '2026-05-22 15:00:00', 0, 'personal', NULL, '#ffd600'),
            
            -- Week 4
            ('female', 'Supplier Master Contract Signoff', '2026-05-25 10:30:00', 0, 'work', NULL, '#448aff'),
            ('male', 'IT Infrastructure Migration Board', '2026-05-26 14:00:00', 0, 'work', NULL, '#448aff'),
            ('boy', 'Rugby Semi-Final Clash', '2026-05-27 15:30:00', 0, 'social', NULL, '#ff3b3b'),
            ('girl', 'Netball Season Finale Tournament', '2026-05-28 14:00:00', 0, 'social', NULL, '#ffd600'),
            ('male', 'Wedding Anniversary Dinner', '2026-05-29 19:00:00', 0, 'social', NULL, '#e91e8c');
        `);

        console.log('8. Seeding Structural Rotational Gym Workouts...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_gymworkout (username, day, exercise, sets, reps, weight, date) VALUES
            -- Mother (Rotational Strength & Core Alignment)
            ('female', 'Monday', 'Barbell Back Squat', 3, '10', '50', '2026-05-04 06:00:00'),
            ('female', 'Monday', 'Barbell Back Squat', 3, '10', '52.5', '2026-05-11 06:00:00'),
            ('female', 'Monday', 'Barbell Back Squat', 3, '10', '55', '2026-05-18 06:00:00'),
            ('female', 'Wednesday', 'Yoga Flow', 1, '45', 'vinyasa', '2026-05-06 06:15:00'),
            ('female', 'Wednesday', 'Yoga Flow', 1, '45', 'power ash', '2026-05-20 06:15:00'),
            ('female', 'Friday', 'Lat Pulldown', 3, '12', '35', '2026-05-22 06:00:00'),
            
            -- Father (Progressive Load Push/Pull/Legs Blueprint)
            ('male', 'Monday', 'Barbell Bench Press', 4, '8', '80', '2026-05-04 17:30:00'),
            ('male', 'Monday', 'Barbell Bench Press', 4, '8', '85', '2026-05-11 17:30:00'),
            ('male', 'Monday', 'Barbell Bench Press', 4, '8', '87.5', '2026-05-18 17:30:00'),
            ('male', 'Tuesday', 'Run · Zone 2', 1, '40', '6.2', '2026-05-05 18:00:00'),
            ('male', 'Tuesday', 'Run · Zone 2', 1, '40', '6.5', '2026-05-19 18:00:00'),
            ('male', 'Thursday', 'Barbell Deadlift', 3, '5', '115', '2026-05-07 17:30:00'),
            ('male', 'Thursday', 'Barbell Deadlift', 3, '5', '120', '2026-05-21 17:30:00'),
            ('male', 'Saturday', 'Dumbbell Bicep Curl', 3, '12', '16', '2026-05-23 09:00:00'),
            
            -- Daughter (Agility & Dynamic Footwork)
            ('girl', 'Tuesday', 'Steady-state running or jogging', 1, '30', '4.2', '2026-05-05 15:30:00'),
            ('girl', 'Tuesday', 'Steady-state running or jogging', 1, '35', '4.8', '2026-05-19 15:30:00'),
            ('girl', 'Thursday', 'Bodyweight Squats', 3, '15', '0', '2026-05-07 16:00:00'),
            ('girl', 'Thursday', 'Bodyweight Squats', 4, '15', '0', '2026-05-21 16:00:00'),
            
            -- Son (Power, Explosiveness & Sprint Capacity)
            ('boy', 'Wednesday', 'Interval sprints', 1, '20', '3.0', '2026-05-06 15:00:00'),
            ('boy', 'Wednesday', 'Interval sprints', 1, '20', '3.5', '2026-05-20 15:00:00'),
            ('boy', 'Friday', 'Push-Ups (standard, wide, diamond)', 3, '10', '0', '2026-05-08 07:00:00'),
            ('boy', 'Friday', 'Push-Ups (standard, wide, diamond)', 3, '15', '0', '2026-05-22 07:00:00');
        `);

        console.log('9. Seeding Granular Daily Meal Logs across the Family...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_mealplan (username, day, meal_type, description, calories, date) VALUES
            -- Mother Metrics
            ('female', 'Monday', 'breakfast', 'Oatmeal with berries and a boiled egg', 320, '2026-05-18 07:30:00'),
            ('female', 'Monday', 'lunch', 'Grilled chicken salad with veggies', 450, '2026-05-18 13:00:00'),
            ('female', 'Monday', 'snack', 'Greek yogurt with raw honey', 160, '2026-05-18 16:15:00'),
            ('female', 'Monday', 'dinner', 'Baked fish with quinoa and broccoli', 510, '2026-05-18 19:15:00'),
            
            -- Father Metrics
            ('male', 'Monday', 'breakfast', 'Protein shake with banana and oats', 520, '2026-05-18 07:00:00'),
            ('male', 'Monday', 'lunch', 'Chicken breast with sweet potato mash', 680, '2026-05-18 13:00:00'),
            ('male', 'Monday', 'snack', 'Handful of mixed walnuts & almonds', 240, '2026-05-18 16:30:00'),
            ('male', 'Monday', 'dinner', 'Salmon with basmati rice and roasted salad', 760, '2026-05-18 19:30:00'),
            
            -- Daughter Metrics
            ('girl', 'Monday', 'breakfast', 'Greek yogurt parfait with mixed nuts', 410, '2026-05-18 07:10:00'),
            ('girl', 'Monday', 'lunch', 'Turkey wrap with garden greens', 420, '2026-05-18 13:15:00'),
            ('girl', 'Monday', 'snack', 'Sliced apple with smooth almond butter', 210, '2026-05-18 16:00:00'),
            ('girl', 'Monday', 'dinner', 'Stir-fried tofu with jasmine rice bowl', 530, '2026-05-18 18:30:00'),
            
            -- Son Metrics
            ('boy', 'Monday', 'breakfast', 'Peanut butter sandwich on whole wheat', 380, '2026-05-18 07:15:00'),
            ('boy', 'Monday', 'lunch', 'Quinoa bowl with shredded beef', 590, '2026-05-18 13:00:00'),
            ('boy', 'Monday', 'snack', 'High-protein shake bar', 290, '2026-05-18 15:45:00'),
            ('boy', 'Monday', 'dinner', 'Lean beef stir-fry with brown egg noodles', 720, '2026-05-18 18:45:00');
        `);

        console.log('10. Injecting Generational Biological Cycle Windows...');
        await pool.query(`
            INSERT INTO vectraarchlegacy_period (username, start_date, end_date, cycle_length, symptoms, date) VALUES
            ('female', '2026-05-02', '2026-05-07', 28, 'Cramps,Fatigue,Backache', '2026-05-02 08:00:00'),
            ('girl', '2026-05-10', '2026-05-14', 30, 'Bloating,Headache', '2026-05-10 09:00:00');
        `);

        console.log('\x1b[32m%s\x1b[0m', 'SUCCESS: Deep data structures successfully applied to VectraArchLegacy!');
    } catch (err) {
        console.error('\x1b[31m%s\x1b[0m', 'CRITICAL REBUILD ERROR:', err.message);
    } finally {
        await pool.end();
    }
}

rebuildAll();
