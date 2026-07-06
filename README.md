<p align="center">
    <h1 align="center">ReeF AI - Instagram Timetable & Reel NoteTaker</h1>
</p>
<p align="center">
    <em>Automated Study Scheduling & Reel Transcription Inside Instagram DMs</em>
</p>
<p align="center">
	<img src="https://img.shields.io/badge/Developer-Drix10-red" alt="Developer Badge">
	<img src="https://img.shields.io/badge/Node.js-v18+-green" alt="Node Version">
	<img src="https://img.shields.io/badge/Database-MongoDB-blue" alt="Database Version">
	<img src="https://img.shields.io/badge/AI-Gemini_3.5_Flash-orange" alt="LLM Version">
</p>
<p align="center">
	<img src="https://img.shields.io/badge/Framework-Express-blue" alt="Framework Badge">
	<img src="https://img.shields.io/badge/Frontend-Instagram_MESSAGING_API-red" alt="Interface Badge">
	<img src="https://img.shields.io/badge/Backend-Node.js_with_Mongoose-blue" alt="Backend Badge">
	<img src="https://img.shields.io/badge/Parser-instagram_private_api-black" alt="Library Badge">
</p>

---

## Description

### What is ReeF AI?
ReeF AI is an intelligent assistant designed to automatically organize your study workflows directly inside your Instagram DMs. When a user shares educational or resource-focused Reels, the assistant downloads the video, transcribes and summarizes the content using Gemini 3.5 Flash, extracts key links or steps, adds them to a weekly schedule, and structures study reminders around deadlines.

### What problem does it solve?
ReeF AI resolves the friction of converting short-form educational content (like Instagram Reels) into actual, actionable study routines. Often, useful resources or guides are lost in bookmarks or saved folders. This bot transcribes those items immediately, helps you schedule study times, sets task deadlines, and sends you personalized learning boards once your milestone dates are reached.

---

## System Architecture

```mermaid
graph TD
    A[Instagram DM Event] -->|Meta Webhook| B[webhook-handler.js]
    B -->|processWebhook| C[index.js / webhook]
    B -->|handleMessage| D[instagramClient.processMessage]
    D -->|CoreClient.js| E[handlers/MessageHandler.js]
    E -->|User Message Queue| F{Is Command or Reel?}
    F -->|Reel URL| G[handlers/GeminiHandler.js]
    F -->|Command/Postback| H[handlers/CommandHandler.js]
    F -->|Chat Message| I[handlers/GeminiHandler.js chatbot]
    G -->|Download Video| J[utils/instagram-downloader.js]
    G -->|Upload & Transcribe| K[Gemini 3.5 Flash API]
    G -->|Save Results| L[(MongoDB: ReelNote / User)]
    H -->|Execute| M[commands/ / buttons/]
    M -->|Query/Update| L
    M -->|Send Message| N[handlers/ApiHandler.js]
    N -->|Instagram Graph API| O[User DMs]
```

---

## Key Features
* **Automated Reel Analysis**: Downloads shared Reel videos, transcribes voice/overlays, and maps them to clean markdown summaries.
* **Dynamic Learning Timetable**: Suggests schedule slots for study routines and allows users to modify schedules via interactive commands.
* **Deadlines & Milestones**: Structures tasks and course deadlines, and triggers automated check-in summaries containing saved resources once deadlines complete.
* **Active DM Reminders**: Periodically polls user routine times and sends DM notifications to keep study habits active.
* **VPS Security Bypass**: Direct browser session cookie import bypasses datacenter IP blocks, avoiding password-based blocks on cloud hostings.
* **Concurrency Control**: Memory-safe sequential user-queues prevent race conditions and MongoDB write collisions.

---

## Commands Reference

All commands are prefixed with the bot's configured prefix (default: `!`).

* `!register` – Set up a user profile in the database.
* `!timetable [clear]` – Display your weekly study schedule or wipe it clean.
* `!notes [view <index>]` – List saved learning resources or view a specific summary in detail.
* `!reminders [clear]` – View scheduled study alerts or cancel all notifications.
* `!deadline [add <name> <date/relative> | list | clear]` – Configure study/task deadlines (e.g., `!deadline add Midterms 2026-07-20` or `!deadline add Finals 10d`).
* `!ping` – Verify backend response latency.

---

## Environmental Settings

Configure these keys inside a `.env` file at the root of the project:

```env
# Database Configuration
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/timetable_bot

# Network Configuration
PORT=25655
TRUST_PROXY=1

# Gemini AI API Configuration
GEMINI_API_KEY=AIzaSy...

# Instagram Graph API Webhook Configuration
INSTAGRAM_ACCESS_TOKEN=IGAAQ...
INSTAGRAM_VERIFY_TOKEN=instagram_reel_timetable_token_verify
INSTAGRAM_APP_SECRET=bab62b11...

# Instagram Scraper Account (Used for authenticated Reel downloads)
IG_USERNAME=your_secondary_instagram_username
IG_PASSWORD=your_secondary_instagram_password

# Admin Bypass Key (Enforces security on session imports)
IG_CHALLENGE_TOKEN=your_secure_admin_bypass_token
```

---

## Session Cookie Import (VPS Bypass)

When hosting on a VPS or cloud container, Instagram blocks password-based authentication due to datacenter IP reputation. To bypass this, you can copy your browser's active session cookies from a personal machine and import them directly to the VPS:

### Step 1: Copy Cookies from Web Browser
1. Log in to Instagram on your laptop web browser.
2. Open **Developer Tools** (`F12`), navigate to the **Network** tab, and refresh the page.
3. Select any successful request to `instagram.com` (such as `graphql/query`).
4. Under **Request Headers**, locate the **`cookie`** header and copy its entire text (it will start with `mid=...` or `ig_did=...`).

### Step 2: Import Cookies via Web Browser
Open your web browser and navigate directly to the import URL, pasting your copied cookies at the end of the query string:

```
http://yourdomain.com/ig/session/import?token=your_challenge_token&cookies=YOUR_COPIED_COOKIE_STRING_HERE
```

#### Example GET Request Link:
```
http://yourdomain.com/ig/session/import?token=your_challenge_token&cookies=mid=akZkMAALAAGpmOkfOxmhzS_Wb1cY; ds_user_id=123456789; sessionid=123456789%3AAcc9QlyukJ9NNY%3A17%3AAYh_66PM
```

### Response Schema (API Reference)

* **Success Response (`200 OK`)**:
  ```json
  {
    "status": "success",
    "username": "your_instagram_username",
    "message": "Cookies imported and verified successfully!"
  }
  ```
* **Error Response (`400 Bad Request` / `501 Internal Server Error`)**:
  ```json
  {
    "error": "Cookies verification failed: GET /api/v1/accounts/current_user/?edit=true - 400 Bad Request; checkpoint_required"
  }
  ```

The bot will:
1. Load cookies into a secure, sandboxed tough-cookie jar.
2. Query Instagram's authenticated `currentUser` endpoint to prove validity.
3. Serialize the session state to `.ig-session.json` with owner-only (`0600`) file permissions.
4. Unblock downloads instantly without needing standard password-based logins.

---

## Production Nginx Configuration

Route incoming port `80`/`443` traffic to local port `25655`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:25655;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## Setup & Run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the application:
   ```bash
   npm start
   ```

---

## Contact

* **Email**: support@coslynx.com
* **Instagram**: [@drix_10_](https://www.instagram.com/drix_10_/)
