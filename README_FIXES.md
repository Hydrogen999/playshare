# Backend fixes and additions (round 7)

Everything here is additive: no existing route, table or response field was removed or renamed.
New tables are created automatically by `Base.metadata.create_all` on the next start (no manual SQL).

## What was broken, and what is fixed

| Problem found in the old backend | Fix |
|---|---|
| **Block / unblock / blocked list / report / privacy / birthday / delete-account did not exist** (the app called `/safety/*`, every call failed) | New `routers/safety.py` + tables `user_blocks`, `user_reports`, `user_safety` |
| Blocking was not enforced anywhere (blocked people could still message, call, find you, add you) | Enforced in search, profile, friend requests, REST DMs, WebSocket DMs, groups, reactions, typing, calls, presence |
| Privacy settings (who can message / call / add, birthday, last seen, online) did not exist | Stored and enforced server-side |
| **Image uploads**: file type trusted from the client (an `.html` file labelled `image/png` could be stored and served from your domain = script injection), no size limit, files lost on every Render restart | `services/media.py`: type read from the file's bytes, size limits per type, stored in the database, served from `/media/<id>.<ext>` with `nosniff` + sandbox CSP, Range support for video/voice |
| Chat `media_url` accepted any string, so anyone could forge "gift:1000" / "challenge:..." messages | Only your own `/media/...` URLs accepted |
| Profile photo upload/delete (`/me/profile/photo`) did not exist | Added |
| `avatar_url` and `is_verified` missing from every user list | Added to `/auth/me`, friends, requests, search, profile, conversations, statuses, suggestions |
| Last-seen never saved (was written to a column that does not exist on `User`) | Now saved on `Profile.last_seen` |
| Online/offline events were sent to **every** connected user | Now only to friends who are allowed to see it, plus a snapshot of who is online when you connect |
| Anyone could react to any message id; anyone could send call signals to anyone | Participants only; call signals only inside a call that passed the permission checks |
| Calls: callee asleep = caller rings forever; no TURN; no quality settings | Offline callee gets "unavailable" (or a push + queued offer if FCM is configured); `/calls/ice` serves STUN + TURN; app asks for echo-cancelled audio and 720p video |
| No push notifications at all (`/push/register` missing, nothing sends) | Token registration + FCM HTTP v1 sender (DMs and incoming calls to phones with no live connection) |
| Missing: `/auth/config`, `/auth/email/send-code`, `/auth/password/forgot|reset`, `/friends/birthdays`, `/friends/suggestions` | Added (email via Resend HTTPS API; Render's free plan blocks SMTP) |
| No brute-force protection on login/signup/codes | Rate limiting (10 logins / 10 min per email+IP, etc.) |
| Webhook hash compared with `==` | Constant-time compare |
| Anyone could add anyone to a group; anyone could mark any status "viewed" | Friends only; friends/self only |
| **Verified accounts** | Full feature: application, private evidence, Flutterwave $50 fee, admin review, audit log, blue tick derived from the approved application |
| Age: no minimum | Signup birthday (when sent) and `/safety/birthday` require age 13+ |

## Deploy (Render)
1. Replace your repo files with this folder (or copy `backend/` over it) and push. `requirements.txt` gained `google-auth` and `requests`.
2. Existing env vars stay. **New / optional env vars** (Render dashboard > Environment):
   - `ADMIN_USERNAMES` = your username (comma separated). On the next start that account becomes admin. Register the account in the app first.
   - `VERIFICATION_RETURN_URL` (optional) – https page after payment. Default: `<your site>/verification/done`, already built.
   - Flutterwave: you already have `FLW_SECRET_KEY`, `FLW_SECRET_HASH`, `FLW_CALLBACK_URL`. Nothing new. Your existing Flutterwave webhook URL (`/api/v1/payments/flutterwave/webhook`) now also settles verification payments (references starting `vfy_`). In the Flutterwave dashboard enable **Google Pay** (Settings > Payment methods) and USD.
   - Calls on mobile data: `TURN_URLS` (e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`) plus EITHER `TURN_SECRET` (your own coturn) OR `TURN_USERNAME` + `TURN_CREDENTIAL` (hosted TURN such as Metered/Twilio).
   - Push: `FCM_SERVICE_ACCOUNT_JSON` = the whole Firebase service-account JSON (Firebase console > Project settings > Service accounts > Generate key).
   - Email codes / password reset: `RESEND_API_KEY` and `MAIL_FROM` (verified sender domain at resend.com). Without them the app hides email codes and password reset answers "not available yet".
   - Make sure `SECRET_KEY` is a long random value (a warning is printed at start-up if it is still the default).
3. After deploy open `/health`, then test in this order: login, block someone, report, upload a photo, apply for verification (use Flutterwave TEST keys first), approve it from the admin screen, make a call.

## Tests
`python -m unittest discover -s backend/tests -v` runs 19 tests of the pure logic (status rules, upload sniffing, fee checks, Flutterwave request/verify handling against a fake, privacy rules, age rule, TURN credentials). They need no installed packages.

## NOT tested (be honest)
I could not run the server, a database, a phone, Flutterwave or a real call from here. Everything that touches the database, the routes, the websockets, FCM, email and WebRTC is syntax-checked and reviewed only. Test each item above on your staging service before real users.

## Things you must decide
- **Media in the database** keeps images alive across restarts, but Neon's free tier is ~0.5 GB. Watch the size; the `save_media` function is the single place to switch to S3/R2 later.
- **Images in chat are not Premium-only** over WebSocket (the old REST route was Premium-only). I left the old REST rule as is; tell me which you want.
- **Refunds** are manual (Flutterwave dashboard). Duplicate payments are flagged `duplicate_paid`.
- **Old JWTs stay valid after a password reset** (stateless tokens). Tell me if you want sessions that can be revoked.
- **Google Play**: selling the verification badge through an outside web checkout can break Play's billing policy. Check before publishing.
