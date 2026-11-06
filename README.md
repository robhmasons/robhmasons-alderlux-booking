# Alderlux booking

Alderlux's own booking system, replacing Calendly. Runs on Cloudflare Workers with a D1 database.
Built to host more than one business (`tenant`), starting with Alderlux only.

## What it does
- Three meeting types (The Edge intro 60 min, Succession consultation 45 min, Corporate briefing 30 min) with the same questions as Calendly, plus a required "How did you hear about Alderlux?".
- Working hours copied from Calendly on 06/11/2026 (Europe/London, including the 05/12/2026 override). UK clock changes handled and tested.
- 12 hours' minimum notice, 60 days ahead, 15-minute buffer between calls, 30-minute start grid.
- Double booking is impossible: the database insert refuses any overlap in a single statement (tested with 5 simultaneous requests).
- Confirmation emails to client and host, a manage link (calendar file and cancellation), reminder email 24 hours before (cron every 30 minutes).
- **Outlook** (Microsoft Graph): checks Robert's Outlook calendar for busy times, adds each booking to it with the client as attendee (Outlook sends the client a calendar invitation and, on cancellation, a cancellation), and sends all emails from the connected mailbox. Google Calendar is supported as an alternative.
- If the calendar can't be read, the page shows "temporarily unavailable" rather than offering times that may clash.
- Brand: near-black ground, gold, Satoshi, approved footer verbatim. No trackers, one font host.

## Run and test
```
npm install
npm test               # 28 unit tests (slots, clock changes, validation, calendar file, Google adapter, emails)
npm run typecheck
npm run e2e            # 18 end-to-end checks against a local Worker and local D1
```

## Cost: £0
Everything runs on Cloudflare's **free** Workers plan. Measured: a 14-day availability lookup takes about 1 ms of processing (free limit 10 ms per request). Free limits that apply: 100,000 requests a day; D1 5 million rows read and 100,000 written a day, 5 GB stored. Alderlux's volume is a tiny fraction of these. Email goes through Outlook, not Cloudflare's paid email service.

## Deploy
1. `npx wrangler login`
2. `npx wrangler d1 create alderlux-booking`, paste the ID into `wrangler.jsonc`, then `npx wrangler d1 migrations apply alderlux-booking --remote`.
3. `npx wrangler deploy`. Note the Worker URL (or attach `book.alderlux.com`).
4. Register a free Microsoft app (one time): Microsoft Entra admin centre, App registrations, New registration.
   - Supported account types: include personal Microsoft accounts (Outlook.com).
   - Redirect URI (Web): `https://<worker-url>/oauth/outlook/callback`.
   - Certificates & secrets: create a client secret. **It expires (24 months at most): put the renewal date in the calendar.**
5. `npx wrangler secret put MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `ADMIN_KEY` (a long random string only Robert knows).
6. Robert opens `https://<worker-url>/oauth/outlook/start?key=<ADMIN_KEY>` once, signs in to Outlook and approves. Check `/oauth/outlook/status?key=<ADMIN_KEY>`.
7. Point the site's buttons at `https://<worker-url>/?type=succession` (or `the-edge`, `corporate`).

## What keeps it running
- Microsoft rotates the connection token; each refresh stores the new one in D1, and the 30-minute reminder job keeps it in use.
- If the connection breaks (password change, consent removed, client secret expired), the page shows "temporarily unavailable" and no clashing times are offered. Fix: renew the secret if needed, then repeat step 6.
- Emails come from the connected Outlook address. Outlook.com applies its own daily sending limits (not checked here); booking volumes are far below any likely limit.

## Not built yet
- Rescheduling in one step (today: cancel and rebook).
- Automatic Zoom links (today: location text; Robert sends the link).
- iCloud calendar.
- An admin screen (today: host email + calendar entry; bookings are in D1).
- Bot protection beyond a honeypot (add Cloudflare Turnstile before any public launch).
- Data retention rule for old bookings (decide a period, then add a monthly delete job).
