# BalloonsBuzz: business notes (Phase 0)

Source: https://www.balloonsbuzz.com (fetched 2026-11-08). Items marked **TO CONFIRM** must be checked with the client before go-live.

## Basics

- **Name:** BalloonsBuzz, a balloon decoration business
- **Address (base for distance calculation):** Beside Reliance Digital, Indira Nagar Colony, Miyapur, Hyderabad, Telangana 500049
  - Base coordinates: **TO CONFIRM.** We need the exact pin from the client; we won't guess it from geocoding.
- **WhatsApp / phone:** +91 93925 34625. The site's "Book Now" button opens `wa.me/9392534625` with a prefilled enquiry.
- **Social:** Instagram `balloonsbuzz_miyapur`, Facebook page (id 61587747171002)
- **Email, business hours, service area radius:** not on the site. **TO CONFIRM.**

## Occasions / services

Birthday (including kids' birthdays), Baby shower, Wedding decor, Anniversary / romantic decor, Corporate / office events.

## Themes (birthday section)

All Kids, Boss Baby, Butterfly, Car, Cocomelon, Frozen, Jungle, Premium Decoration, Marvel, Mickey Mouse (spelled "Micky" on the site), Tom & Jerry, Barbie, Angels, "Oscan".

- "Oscan" is probably **Ocean**. **TO CONFIRM.**
- Theme pages contain **no photos, prices or inclusions** (the Frozen page is even titled "Baby Shower"). **The client must supply the gallery photos**, tagged by theme, occasion and package.
- Character themes (Frozen, Marvel, Mickey, Barbie, Cocomelon, Boss Baby, Tom & Jerry) are trademarked names. They are fine as descriptive labels in chat. No branded assets will be shipped by us; the gallery will hold the client's own event photos.

> **Decision (2026-11-08): website prices are ignored.** Prices come only from the Drive photo folder names. See [gallery-catalog.md](gallery-catalog.md). The table below is kept for reference only.

## Packages and prices (as written on the site)

| Package | Site label | Issue |
|---|---|---|
| Ring Frame | 3500/- | |
| Single Frame | 4500/- | |
| 2 Frames | 6000/- | |
| 3 Frames (spelled "3 Freames") | 16000/- | **Inconsistent:** costs more than the low end of 4 Frames. Possibly a typo for 6,000–9,000. **TO CONFIRM** |
| 4 Frames | 9000/- to 35000/- | A range, not a price. What drives it? **TO CONFIRM** |
| Theme Decorations | 35000/- | Fixed or "starting from"? **TO CONFIRM** |

- Every package description on the site is placeholder text ("Provide a short description of the dish and its ingredients"). **Inclusions per package: TO CONFIRM.**
- All seed prices go in as **TODO placeholders** and the agent never quotes outside configured pricing.

## Needed from the client for the four mandatory customisations

1. **Photos per requirement:** gallery images with tags (theme, occasion, package, approximate price band) and any captions.
2. **Human handover:** who answers (names and numbers), working hours, and the message to send while waiting.
3. **Negotiation limit:** maximum discount per package (% or ₹) and an overall cap, and whether it applies to add-ons and the distance charge.
4. **Distance charge:** base pin, distance slabs (for example 0–5 km free, 5–10 km ₹X, ...), maximum serviceable distance, and whether to use road distance (Google Maps, needs an API key) or straight-line distance.

## Other open questions

- Advance amount (fixed or %), payment method (UPI ID/QR, Razorpay, ...), and cancellation/refund policy.
- Lead time (how many days in advance they need), and how many events per day (capacity).
- Add-ons (name/age foil letters, LED, cake table, fog, photographer, ...) and their prices.
- Languages: English only, or Telugu/Hindi too (common in Hyderabad).
- An existing Meta Business / WhatsApp Cloud API setup on +91 93925 34625? Moving that number to the API affects how it is used on the WhatsApp Business app (coexistence mode).
