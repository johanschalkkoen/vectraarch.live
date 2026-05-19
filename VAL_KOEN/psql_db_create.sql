-- 1. Create the user
CREATE USER "VAL_KOEN" WITH PASSWORD 'JEujtrxESlCXZzy1';
-- 2. Create the database
CREATE DATABASE "VAL_KOEN" OWNER "VAL_KOEN";
-- 3. Grant permissions
GRANT ALL PRIVILEGES ON DATABASE "VAL_KOEN" TO "VAL_KOEN";
-- 4. Connect to the new database to create tables
\c VAL_KOEN

-- Set search path and default ownership
SET ROLE "VAL_KOEN";

CREATE TABLE "VAL_gym_options" (id SERIAL PRIMARY KEY, data JSONB);
CREATE TABLE "VAL_meal_templates" (id SERIAL PRIMARY KEY, data JSONB);
CREATE TABLE "VAL_access" (id SERIAL PRIMARY KEY, user_id INT, access_level TEXT);
CREATE TABLE "VAL_budget" (id SERIAL PRIMARY KEY, amount NUMERIC, category TEXT);
CREATE TABLE "VAL_calendar" (id SERIAL PRIMARY KEY, event_date TIMESTAMP, title TEXT);
CREATE TABLE "VAL_financial" (id SERIAL PRIMARY KEY, balance NUMERIC);
CREATE TABLE "VAL_gymprogram" (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE "VAL_gymprogram_exercise" (id SERIAL PRIMARY KEY, program_id INT, exercise_name TEXT);
CREATE TABLE "VAL_gymworkout" (id SERIAL PRIMARY KEY, workout_date DATE);
CREATE TABLE "VAL_mealplan" (id SERIAL PRIMARY KEY, plan_details TEXT);
CREATE TABLE "VAL_notifications" (id SERIAL PRIMARY KEY, message TEXT, read BOOLEAN DEFAULT FALSE);
CREATE TABLE "VAL_period" (id SERIAL PRIMARY KEY, start_date DATE, end_date DATE);
CREATE TABLE "VAL_transaction_history" (id SERIAL PRIMARY KEY, amount NUMERIC, ts TIMESTAMP DEFAULT NOW());
CREATE TABLE "VAL_users" (id SERIAL PRIMARY KEY, username TEXT UNIQUE, email TEXT);

-- Verify everything was created correctly
\dt