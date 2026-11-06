# Alderlux booking

Alderlux's own booking system, replacing Calendly. Runs on Cloudflare Workers with a D1 database.
Built to host more than one business (`tenant`), starting with Alderlux only.

## What it does
- Three meeting types (The Edge intro 60 min, Succession consultation 45 min, Corporate briefing 30 min) with the same questions as Calendly, plus a required "How did you hear about Alderlux?".
- Working hours copied from Calendly on 06/11/2026 (Europe/London, including the 05/12/2026 override). UK clock changes handled and tested.
- 12 hours' minimum notice, 60 days ahead, 15-minute buffer between calls, 30-minute start grid.
- Double booking is impossible: the database insert refuses any overlap in a single statement (tested with 5 simultaneous requests).
- Confirmation emails to client and host, a manage link (calendar file and cancellation), reminder email 24 hours before (cron every 30 minutes).
- Optional Google Calendar: reads busy times and adds each booking to the calendar. If Google is unreachable, the page shows "temporarily unavailable" rather than offering times that may clash.
- Brand: near-black ground, gold, Satoshi, approved footer verbatim. No trackers, one font host.

## Run and test
```
npm install
npm test               # 28 unit tests (slots, clock changes, validation, calendar file, Google adapter, emails)
npm run typecheck
npm run e2e            # 18 end-to-end checks against a local Worker and local D1
```

## Deploy (needs Robert's approval: the Workers Paid plan is $5 a month)
1. `npx wrangler login`
2. `npx wrangler d1 create alderlux-booking` and paste the ID into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply alderlux-booking --remote`
4. Upgrade to Workers Paid, onboard alderlux.com in Cloudflare Email Service, and uncomment `send_email` in `wrangler.jsonc`.
5. Optional Google Calendar: `npx wrangler secret put GOOGLE_CLIENT_ID` (and `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`).
6. `npx wrangler deploy`, then point `book.alderlux.com` at the Worker and link the site's buttons to `https://book.alderlux.com/?type=succession` (or `the-edge`, `corporate`).

## Not built yet
- Rescheduling in one step (today: cancel and rebook).
- Automatic Zoom links (today: location text; Robert sends the link).
- Outlook / iCloud calendars (Google only).
- An admin screen (today: host email + calendar entry; bookings are in D1).
- Bot protection beyond a honeypot (add Cloudflare Turnstile before any public launch).
- Data retention rule for old bookings (decide a period, then add a monthly delete job).
