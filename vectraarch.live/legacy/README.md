# VectraArch Live
### Architectures for Engineered Growth, Infrastructure, and Human Systems

Welcome to VectraArch.live, a unified digital ecosystem where systems engineering intersects 
with personal development, infrastructure management, and life-logging frameworks. Rooted 
in the philosophy of building resilient human systems, VectraArch serves as the centralized 
control plane for applications designed to optimize everyday performance, manage mission-critical data, 
and secure personal growth.

## The Ecosystem Architecture

Our digital infrastructure is divided into distinct, purpose-built subdomains—referred to 
as nodes—each engineered to manage a specific component of our operational framework:

* **Keystone:** The central foundation anchoring the entire architecture. Keystone handles identity 
    federation, user profiles, and master accessibility parameters across the ecosystem.
* **Forge:** The development node where applications, custom microservices, system automations, 
    and secure technical integrations are coded, tested, and deployed.
* **Conduit:** The operational routing pipeline designed for seamless data synchronization, 
    external communications tracking, system alerts, and telemetry pipelines.

## Featured Platform: OurLife (Legacy Engine)

Hosted within the VectraArch infrastructure is **OurLife**, an all-in-one personal growth and 
legacy-building software suite. Designed to empower individuals, mentors, and close circles 
to organize their operational lives with maximum security, OurLife brings institutional-grade 
infrastructure standards to personal data management.

### Operational Capabilities:
* **Secure Financial Ledgering & Automated Bank Parsing:** Includes advanced transaction loggers, 
    flexible budget builders, and a state-aware parsing engine that instantly translates raw 
    banking statements into structured expense analytics.
* **Biometric & Physical Engineering:** Comprehensive scheduling interfaces tracking physical progress, 
    workout optimizations, target nutrition modeling, and physiological metric monitoring.
* **Data Delegation & Mentorship Networks:** A transactional shared-access layer enabling 
    authorized bidirectional profile synchronization, allowing family members, coaches, or 
    trusted mentors to provide structured oversight and accountability.
* **Hardened Security Architecture:** Built upon a modernized PostgreSQL database cluster, protected 
    by working-factor password hashing, isolated multi-channel notifications (Telegram/Email), 
    and strict Time-Based One-Time Password (TOTP) two-factor authentication.

VectraArch is more than a collection of tools—it is an ongoing engineering commitment to continuity, 
precision tracking, and structural life optimization.


Part 1: Deep Technical Breakdown of server.js
This backend is an all-in-one API gateway for your ecosystem, built on Express.js and running securely over HTTPS. It has recently been refactored to replace an old SQLite architecture with a robust PostgreSQL (pg) engine using connection pooling (Pool) for better concurrency.

Here is exactly what happens under the hood across your different service layers:

1. Core Architecture & Database Helpers
Configuration: Loads secure parameters (DB credentials, Telegram tokens, API keys) from a localized .env file at /var/www/vectraarch.live/forge/.env.

Database Management: Leverages three abstract async utilities (dbQuery, dbAll, dbRun) and an explicit dbTransaction handler to guarantee atomic execution (All-or-Nothing) using SQL BEGIN, COMMIT, and ROLLBACK commands.

Column Normalization: A mapUser data transformer normalizes standard table attributes to ensure camelCase compatibility with frontends, setting fallbacks for themes (dark), profiles, and pronouns.

2. Advanced Security & 2FA Engine
Password Hashing: Uses bcrypt with a work factor of 10 for authentication checking and updates.

Two-Factor Authentication (2FA): Implements time-based OTPs (otplib). When a user sets up 2FA, the backend generates an otpauth:// URI and encodes it as a DataURL QR code using qrcode. Logins check for a twofa_secret column; if present, the app intercepts standard login flows and requires verification at /api/verify-2fa. Admin endpoints can override and force-reset a locked out user's secret to NULL.

Network & Routing Security: The application binds to two ports:

Port 1000 (HTTP) traps all traffic and forces a permanent 301 Redirect to HTTPS.

Port 8443 (HTTPS) manages fully encrypted traffic utilizing production Let’s Encrypt SSL certificates.

3. Data Auditing & External Notifications
Audit Logs: Features a tracking system (logTransaction) that writes every critical system event (LOGIN, CREATE, UPDATE, DELETE, GRANT_ACCESS) to a transaction history ledger (vectraarchlegacy_transaction_history).

Multi-Channel Delivery: Integrates https requests out to the Telegram Bot API (/sendMessage) to flag team actions (e.g., adding or removing users) to a designated group chat. Users can toggled custom preferences to receive automated account updates via Gmail (nodemailer) or Telegram.

4. System Logic & Operational Modules
Cross-Account Access Delegation: Features a complex shared access mechanism (vectraarchlegacy_access). When an admin shares access between two profiles, the database manages bidirectional visibility lines via mutual insertion loops inside a database transaction, allowing users to safely view or monitor linked records.

Automated Financial Bank Statement Importer: Parses raw text strings copy-pasted directly from banking interfaces (configured for Discovery Bank). It runs a state-aware calculation script: it analyzes continuous account balance lines to accurately infer whether a line item was a debit (expense) or a credit (income). It then scans the description fields using an absolute array matrix of business-specific strings to instantly categorize data into fields like Groceries, Fuel, Utilities, or Entertainment.

Integrated Productivity Suites: Manages sub-tables tracking everyday life operations:

Finances & Budgeting: Implements JSONB-compatible array inputs for budget items, sorting expenditures by customizable types. Whenever financial inputs pass through, they trigger synchronized, mirrored data insertions straight into the user's master Calendar Event Hub.

Gym Workouts & Meal Plans: Coordinates relational lookups mapping structural workout sets, weights, and daily localized dietary tracking records. It pulls structural boilerplate profiles directly from pre-seeded master template tables (legacy_gym_options and legacy_meal_templates).

5. Identity Federation Proxy
Acts as a trusted reverse-proxy gateway interfacing with an isolated internal engine running on 127.0.0.1:3200. Requests traversing endpoints containing /api/identity/* are intercepted, signed securely using an internal API Master Key (X-API-Key), forwarded via an inline fetch loop to resolve user links, and seamlessly proxied back to the UI.
