# Live eval: BalloonsBuzz agent on real DeepSeek

Run 2026-11-10T05:28:53.150Z on the dev database through the AI test console (nothing sent on WhatsApp).

## 5. Booking

**Customer:** Hi, I want a semi arch decoration for my wife’s birthday
**Bot:** Sure! 🎈 A semi arch for her birthday is a lovely choice. I don't have semi arch photos in the gallery to show you right now, sorry! Semi arch comes to approx. ₹10,000 — the team confirms the final amount.

What colours or theme do you have in mind — pink and gold, or something else?
<sub>outcome: replied · tools: update_lead, send_photos, get_pricing, send_photos · 14.3 s · 11564+666 tokens · ₹0.182</sub>

**Customer:** What is the price?
**Bot:** Semi arch decoration comes to approx. ₹10,000. 🎈 Travel is extra and depends on the distance from our Miyapur studio — the team confirms the final amount.

Shall I get the venue pin to work out the travel? What date is the birthday?
<sub>outcome: replied · tools: get_pricing · 8.4 s · 7437+233 tokens · ₹0.078</sub>

**Customer:** Ok fine. It is on 2027-01-23 at 7 pm, Flat 12B, My Home Avatar, Narsingi. About 25 people
**Bot:** Please share the venue location pin so I can check the travel charge 🎈
**Bot:** Perfect, noted — 23 Jan 2027, 7 pm, Narsingi, 25 guests. 🎈

I've sent a button for the venue pin, that helps me work out the travel charge.
<sub>outcome: replied · tools: update_lead, request_location · 8.7 s · 7664+276 tokens · ₹0.083</sub>

**Customer:** Yes, please book it
> _team note:_ 📅 Booking BB-1002 created by the bot: 2027-01-23, ₹10,000, advance ₹0 pending ⚠️ Travel charge not included (no venue pin): confirm it with the customer.
> _team note:_ 🤖 Handed over: Booking BB-1002 created; advance amount and payment details need to be shared by the team (travel charge also not calculated — customer did not share the venue pin). Semi Arch birthday decor for wife, 23 Jan 2027, 7 pm, Flat 12B My Home Avatar Narsingi, 25 guests, agreed ₹10,000. Booking code BB-1002 created. Needs payment details + travel charge confirmation.
**Bot:** Sure! Connecting you with our team now 😊 Someone will reply here shortly.
<sub>outcome: handover · tools: create_booking, update_lead (failed), update_lead, handover_to_human · 15.9 s · 8257+1010 tokens · ₹0.162</sub>

Lead after: occasion Birthday, theme -, date 2027-01-23, missing [budget]. Mode: human. Quotes: Semi Arch ₹10000 (floor ₹9000, accepted); Semi Arch ₹10000 (floor ₹9000, superseded).

**Total: 4 turns, ₹0.51.**
