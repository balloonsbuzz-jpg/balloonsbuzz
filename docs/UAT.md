# BalloonsBuzz: acceptance checklist

Go through this together with BalloonsBuzz on the live system, using a staff phone as the
"customer". Tick each line when it behaves as described; note anything that doesn't in the
last column. Sign at the end when everything needed for launch is ticked.

Tester: ____________________   Date: ____________   Dashboard: https://__________________

## A. Before starting

| # | Check | ✓ | Notes |
|---|---|---|---|
| A1 | Dashboard opens over https with a padlock; sign-in works | | |
| A2 | Settings → WhatsApp shows the BalloonsBuzz number as connected; *Check connection* is green | | |
| A3 | Settings → Business: base location pin, advance %, UPI id and team alert phones are filled in | | |
| A4 | Pricing & Rules: packages show the real prices; discount limits and distance slabs are the agreed ones | | |
| A5 | Templates: the five recommended templates show **Approved** | | |
| A6 | AI Agent is **on**; Follow-ups wanted by the client are switched on | | |

## B. A customer enquiry from start to booking

From the test phone, message the business number on WhatsApp.

| # | Do | Expect | ✓ | Notes |
|---|---|---|---|---|
| B1 | "Hi, I want a birthday decoration" | A friendly reply within a few seconds, asking about the event | | |
| B2 | Give theme, date, budget (e.g. "Spiderman, 20 Dec, around 10k") | Photos that match the theme and budget, each with a short caption. No photo without a proper name | | |
| B3 | Ask "how much for the first one?" | A clear price that matches Pricing & Rules | | |
| B4 | Send the venue location (WhatsApp → Location) | Travel charge from Miyapur added according to the distance slabs (or "free" inside the free radius) | | |
| B5 | Ask for a discount twice | Small reductions only, never below the minimum price set in Pricing & Rules | | |
| B6 | Ask for a much bigger discount | The bot does **not** agree; it hands the chat to the team and the team alert phone gets a WhatsApp alert | | |
| B7 | In the dashboard Inbox, open the chat → *Take over*, reply as staff, then *Resume bot* | The customer gets the staff reply; after resuming, the bot answers the next message | | |
| B8 | Confirm the booking in the chat | A booking code (BB-…), the advance amount and the UPI id | | |
| B9 | Bookings → open the booking → *Record payment* for the advance | Status becomes Confirmed; the customer receives the confirmation message | | |
| B10 | Contacts & Leads | The customer appears with occasion, theme, date, venue and "Won" | | |

## C. Team controls

| # | Do | Expect | ✓ | Notes |
|---|---|---|---|---|
| C1 | Customer types "talk to a person" | Chat moves to **Need a person** (red badge in the menu and on the Dashboard) | | |
| C2 | *Pause bot* on a chat, customer writes again | The bot stays silent; staff can reply | | |
| C3 | Add a note on a chat | The note is visible to staff only, never sent | | |
| C4 | Move a booking card on the Bookings board (e.g. to Completed) | Status changes and is kept after refresh | | |
| C5 | Book a second event on a day that is already full | A capacity warning appears | | |

## D. Gallery and pricing

| # | Do | Expect | ✓ | Notes |
|---|---|---|---|---|
| D1 | Gallery: search a theme (e.g. "frozen") | Matching photos with prices from the folder names | | |
| D2 | Hide one photo, then ask the bot for that theme | The hidden photo is never sent | | |
| D3 | Change a package price, then ask the bot | The bot quotes the new price | | |
| D4 | Pricing & Rules → Quote: a sample quote with a far venue | Same total the bot would give | | |

## E. Reminders, broadcasts, opt-out

| # | Do | Expect | ✓ | Notes |
|---|---|---|---|---|
| E1 | Booking for tomorrow exists, event reminder on | The customer gets one reminder the day before (only one) | | |
| E2 | Get a price, then stay silent (quote nudge on) | One friendly nudge after the set hours; none if you reply first | | |
| E3 | Broadcasts → new broadcast to a small tag (e.g. "Test") → send | Only tagged contacts receive it; delivered/read counts update | | |
| E4 | From the test phone send **STOP** | A confirmation; no further broadcasts. **START** subscribes again | | |

## F. Dashboard and reports

| # | Do | Expect | ✓ | Notes |
|---|---|---|---|---|
| F1 | Dashboard | Today's counts and the next 7 days' events are right | | |
| F2 | Analytics → This month | Enquiries, bookings, money collected match what was done in this test | | |
| F3 | Analytics → *Bookings CSV* | Opens in Excel; names and amounts correct; no phone numbers | | |

## G. Safety and recovery (with the developer)

| # | Check | ✓ | Notes |
|---|---|---|---|
| G1 | Uptime monitor is set up and sends an alert when the site is stopped for a few minutes | | |
| G2 | Last night's backup exists and the backup check (healthchecks.io) is green | | |
| G3 | `docker compose run --rm backup drill` ends with **RESTORE DRILL PASSED** | | |
| G4 | Copies of `ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` are kept safely outside the server | | |
| G5 | A staff (Agent) account cannot open Analytics, Settings or Pricing edits | | |

## Sign-off

Everything needed for launch works as described above. Open items (if any) are listed in the
notes with an agreed date.

BalloonsBuzz: ____________________ (name, signature, date)

Developer: ____________________ (name, signature, date)
