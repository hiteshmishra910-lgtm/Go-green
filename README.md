# EcoVerify — AI-Powered Smart Waste Management & Sustainability Rewards

EcoVerify is a full-stack waste verification and sustainability rewards platform connecting **Residents**, **Collectors**, and **Municipal Administrators** with Firebase Authentication, Cloud Firestore, QR pass verification, and server-side Google Gemini image classification.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Recharts, Lucide React
- **Backend / Serverless API:** Express (`server.ts`) & Vercel Serverless Functions (`/api/classify-waste.ts`, `/api/health.ts`)
- **AI Vision:** `@google/genai` (`gemini-4-hydrogen`) running strictly server-side
- **Auth & Database:** Firebase Authentication & Cloud Firestore (`firebase-applet-config.json`, `firestore.rules`)
- **QR & Camera:** Browser `MediaDevices` API, `qrcode`, `jsqr`

## Environment Variables

Configure these variables on the server (never expose `GEMINI_API_KEY` with a `VITE_` prefix):

| Variable | Required | Where to Configure | Purpose |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Yes | AI Studio Secrets / `.env` / Vercel Environment Variables | Server-side Gemini AI waste classification in `/api/classify-waste` |
| `APP_URL` | Optional | AI Studio Runtime / `.env` | Application host URL reference |

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from `.env.example` and add your Gemini API key:
   ```bash
   cp .env.example .env
   ```
3. Start the full-stack dev server on port 3000:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   npm start
   ```

## Firebase Authentication Setup

- **Google Sign-In:** Enabled automatically via `firebase-applet-config.json`.
- **Email / Password Sign-In:** In the Firebase Console for your project, go to **Authentication → Sign-in method** and enable **Email/Password** if you want users to register with email and password. New email/password accounts must click their verification link before writing to Firestore.
- **Role Security:** New users always register as `resident`. Collector approvals and Administrator promotions are controlled via `firestore.rules` and the Admin Dashboard (`Users & Roles`).

## Vercel Deployment

1. Push this repository to GitHub and import the project into Vercel.
2. Framework Preset: **Vite** (`npm run build` outputs `dist/`).
3. Add the required server environment variable in Vercel:
   - Go to **Project Settings → Environment Variables**
   - Add `GEMINI_API_KEY` with your actual Google Gemini API key (select Production, Preview, and Development).
4. **Important:** After adding or updating `GEMINI_API_KEY`, trigger a **Redeploy** from the Vercel Deployments tab so serverless functions pick up the new environment variable.
5. `vercel.json` routes `/api/*` requests to `/api/classify-waste.ts` and `/api/health.ts`, and rewrites all client routes to `/index.html`.

## Verification & Testing Checklist

1. **Authentication:** Test Resident Google Sign-In and Email/Password registration + verification.
2. **Resident Dashboard:** Confirm unique `ECO-...` Resident ID and downloadable QR pass appear; schedule a waste pickup request.
3. **Collector Dashboard:**
   - Scan a Resident QR code via camera or QR image upload, or look up the Resident ID manually.
   - Capture waste with rear camera or upload a photo from gallery.
   - Verify `/api/classify-waste` returns category, confidence estimate, recyclability, explanation, and disposal suggestion.
   - Confirm or override category and submit; verify Firestore updates `collections`, `rewardTransactions`, `residentCards`, `leaderboard`, and `notifications`.
4. **Admin Dashboard:**
   - Review analytics, daily/weekly/monthly charts, AI accuracy vs. collector corrections, and export CSV reports.
   - Approve collector applications, assign service areas, adjust reward points with an audit reason, and save category reward settings.
