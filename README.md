# Instagram AI Learning & Timetable Manager

An Instagram bot that automatically transcribes shared educational Reels, constructs weekly learning timetables, tracks saved study resources, and manages exam blocker deadlines using Gemini 3.5 Flash.

## Core Features
*   **Reel Transcription**: Automatically processes shared Reels, extracts key educational steps/resource links, and parses them into structured JSON summaries.
*   **Weekly Timetables**: Maps suggested study schedules directly to the user's weekly timetable.
*   **Exam Blocker Deadlines**: Allows users to set active blocker deadlines (e.g., exams). Once the blocker date completes, the bot DMs the user with a study summary containing their saved learning resources.
*   **Active Reminders**: Periodically alerts users about scheduled learning activities in direct messages.
*   **Memory-Safe Concurrent Queue**: Queues messages per-user sequentially to prevent database write conflicts while processing messages for different users concurrently.

## Commands List
*   `!register` - Register a user profile
*   `!timetable [clear]` - View or reset the weekly study schedule
*   `!notes [view <index>]` - List saved Reel notes or view detailed resources/steps
*   `!reminders [clear]` - Manage active learning DMs
*   `!deadline [add <name> <YYYY-MM-DD or relative days like 5d> | list | clear]` - Manage blocker timelines (study schedules pause during exams; congratulations and study materials alert once completed)
*   `!ping` - Verify API response latency

## Production Deployment

### 1. Configure the Environment
Create a `.env` file in the root of the project (copying values from `.env.example`):
```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/timetable_bot
PORT=25655
PREFIX=!
GEMINI_API_KEY=AIzaSy...
INSTAGRAM_ACCESS_TOKEN=IGAAQ...
INSTAGRAM_VERIFY_TOKEN=instagram_reel_timetable_token_verify
INSTAGRAM_APP_SECRET=bab62b11...
```

### 2. Configure Webhooks
On the Meta App Dashboard under Instagram Graph API settings:
*   **Callback URL**: `https://yourdomain.com/webhook`
*   **Verify Token**: `instagram_reel_timetable_token_verify`
*   **Subscribed Fields**: `messages`, `messaging_postbacks`

### 3. Expose Port 25655
Configure Nginx (or your reverse proxy) to route traffic to local port `25655`:
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
    }
}
```

### 4. Start the Application
Install production dependencies and launch the process manager:
```bash
npm install
npm start
```
