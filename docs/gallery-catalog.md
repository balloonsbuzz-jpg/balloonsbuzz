# Gallery: design photos and their prices

Source of truth: the client's Google Drive folder **"DECORATION NEW PHOTOS - Copy"**
(`https://drive.google.com/drive/folders/1dWyYHT5_0aFBMXIpkCLVDv9OL6Mep-7q`).
The initial snapshot was analysed from `D:\Downloads\DECORATION NEW PHOTOS - Copy-20261106T052929Z-1-001.zip` on 2026-11-08 (read-only, not extracted).

## What's in it

| Metric | Value |
|---|---|
| Files | 910 (821 unique by content; 89 exact duplicates, 78 of them filed under more than one category) |
| Formats | jpeg 470, jpg 408, jfif 27, png 2, webp 2, avif 1 |
| Size | 221 MB total; largest 8.7 MB; 2 files over WhatsApp's 5 MB image limit |
| Price in **file name** | 237 |
| Price only in a **folder** name | 372 |
| **No price anywhere** | 301 → falls back to a category default (see below) |

## How the folder tree maps to the catalogue

`<top folder = design category>/<sub folder = theme or style>/<file name = design title + price>`

| Top folder | Category key | Occasion | Price label seen |
|---|---|---|---|
| `RING frame` | `ring_frame` | birthday (+ anniversary, welcome baby sub-folders) | per file / sub-folder, e.g. `ring (5.5k-7k)` |
| `single frame` | `single_frame` | birthday (+ welcome baby, congratulations) | mostly none → category default |
| `2 frames decor` | `two_frames` | birthday | per file, e.g. `8k`, `(10k-12k)` |
| `3 frame decor` | `three_frames` | birthday | per file |
| `more then 3 frames` | `four_plus_frames` | birthday | per file, `(18k-35k)` |
| `big frame` | `big_frame` | birthday, baby shower, 50th, congratulations | sub-folder / file, `(10k-30k)` |
| `BASIC (3.5-5k)` | `basic` | birthday | folder `3.5k-5k` |
| `balloon bunches(3.5k-5k)` | `balloon_bunches` | any | folder |
| `Bunches( 40per bunch)` | `bunch_unit` | any | **₹40 per bunch** (unit price, not a package) |
| `car trunk decor(2.5k-3.5k)` | `car_trunk` | surprise / birthday / anniversary | folder |
| `semi arch(6k-10k)` | `semi_arch` | any | folder |
| `welcome arch` | `welcome_arch` | birthday | none → default |
| `moon theme (7.5k-10k)` | `moon_theme` | birthday / baby shower | folder |
| `baby shower/{ring frame(5.5k-7k), single frame, wall (4k-4.5k)}` | sub-folder style | baby shower | sub-folder / file |
| `basic baby shower(3.5k-5k)` | `basic` | baby shower | folder |
| `ring baby shower/{flex ring, simple ring (6k-8k)}` | `ring_frame` | baby shower | sub-folder / file |
| `basic welcome baby(3.5k-5k)` | `basic` | welcome baby | folder |
| `cradle ceremony` | `cradle_ceremony` | cradle ceremony / naming | per file `(8k-10k)` |
| `twin birthday` | `twin_birthday` | birthday | per file |
| `congulations` | `congratulations` | congratulations | per file |
| `helium decor` | `helium` | any | none → default |
| `cut outs`, `sequence sheet` | `addon_cutout`, `addon_sequence_sheet` | add-on | none → **TO CONFIRM** |

Style sub-folders (`flex`, `ring`, `simple ring`, `simple flex`, `plain flex`, `single frame curtains`, `normal theme`, `simple`, `New folder`) become a `style` tag, not a theme.

## Which photos the bot may send (decided 2026-11-08)

A photo is **sendable only if it has a proper name AND a price**:

- **Proper name:** the file name describes the design, for example `Dinosaur Theme (10k-12k)`, `Instant Decors (3)` or `Baby Shower (7k-8k)`.
- **Not proper, never sent:**
  - content hashes (`91a76e65cbf06db5...`)
  - UUIDs
  - `WhatsApp Image 2026-...`
  - `IMG_...`
  - plain numbers
  - marketplace or web-download names (`71IC2lqIgdL._AC_UF1000,1000_QL80_`, `saini-event-decoration-patna-...`)
- **Name is only a price** (17 files, for example `2 frames decor/boss baby/8k.jpg`): sendable. The design comes from the folder (Boss Baby, 2 frames).
- **Price:** taken from the file name, otherwise the nearest folder. **Website prices are ignored**; the folder data is the only price source.

| Bucket | Files | Bot sends? |
|---|---|---|
| Proper name + price in name | 220 | ✅ |
| Proper name + price in folder | 142 | ✅ |
| Price-only name (design from folder) | 17 | ✅ |
| Proper name, **no price** (sequence sheet, cut outs, helium, some single frame / welcome arch) | 155 | ❌ until a price is added (rename in Drive, or set it in the admin UI) |
| Generic or web-download name | 376 | ❌ never; listed in the import report so the client can rename them in Drive |

**~379 sendable photos** at the first import. Renaming a file in Drive (for example `WhatsApp Image ... .jpeg` → `Unicorn Ring (6k-7k).jpeg`) makes it sendable on the next sync.

## Price resolution (most specific wins)

1. **File name** price: `8k`, `7.5k`, `(10k-12k)`, `(5-7k)`, `(6.5k-8.5)`, `14k-15k`, `5k - 6k`. The parser tolerates a missing `k`, stray `)`, extra spaces, and `-copy`/`(2)` suffixes.
2. Nearest **folder** price (sub-folder before top folder).
3. A manual price set in the admin UI (`gallery_overrides`).
4. Nothing → not sendable, and listed in the import report.

Prices are stored as `price_min` / `price_max` in ₹ (a single value means min = max). Gallery prices are **display estimates**. The binding quote still comes from the quote engine (category price ± theme surcharge + distance charge, within negotiation limits), so the "never invent prices" guard keeps working.

## Theme normalisation (typos in folder/file names → canonical theme)

`birbe`→Barbie · `dinosour`/`dinosor`→Dinosaur · `pegga pig`→Peppa Pig · `paw petrol`→Paw Patrol · `trasformer`→Transformers · `vehicals`/`vechical`→Vehicles · `sipder man`→Spiderman · `baby boss`→Boss Baby · `roblex`→Roblox · `hallowen`→Halloween · `anniversery`→Anniversary · `congulations`→Congratulations · `castel`→Castle · `thomas and frds`→Thomas & Friends · `tom&jerry`/`tom & jerry`→Tom & Jerry · `under water`/`underwater`/`sea water theme`→Underwater · `foot ball`→Football · `micky`→Mickey Mouse · `Powrepuff`→Powerpuff Girls · `cardle ceremeony`→Cradle Ceremony · `casion`→**TO CONFIRM** (occasion?).

Each canonical theme keeps an alias list so customer phrases ("spidey", "cars", "minnie") match too.

## Matching a customer request to photos

Inputs from the conversation: occasion, theme, budget (₹ or a range), style preference, and how many photos they want (default 3, max 5).

1. Filter `is_active` images with a resolved price.
2. Score each image:
   - theme match (exact or alias) +5
   - occasion match +3
   - budget fit: the image's price range overlaps the customer's budget +4; above budget by ≤15% +1, so we can upsell gently
   - style match +1
   - already sent in this conversation: excluded
3. Return the top N, spread across categories where possible (for example one single frame, one 2-frame and one ring frame within budget).
4. Captions are short and include the design title and **"₹X–Y (estimate)"**.
5. If nothing fits the budget, send the closest cheaper option plus a note. Never send random photos.

## Google Drive sync

- **Initial load:** import from the zip (no Google credentials needed).
- **Ongoing:** a **Drive sync job** (cron every 30 min plus a "Sync now" button in Gallery):
  - Drive API v3 lists the folder recursively (`files.list` with `q='<folderId>' in parents`).
  - Diffs on Drive `fileId` + `md5Checksum` + path.
  - Downloads new or changed files and **normalises** them with sharp (any format → JPEG, longest side 1600 px, < 1 MB).
  - Stores the result in MinIO, then re-parses path and file name for category, theme and price.
  - Marks deleted Drive files `is_active = false`.
- Images are served to WhatsApp from **our** storage URL (or a cached Meta media id), never from Drive links. Drive share links aren't direct image URLs and fail as WhatsApp media.
- Auth: **decided.** The folder is shared as "anyone with the link" and a Google API key (`GDRIVE_API_KEY`) is used. Wired up **before production**; development and testing use the zip import.
- Manual overrides made in the UI (price, theme, hide) are stored separately and **survive re-syncs**.

## Data issues to raise with the client

1. 376 photos with generic names (hashes, `WhatsApp Image ...`, web downloads) are excluded. The client can rename the good ones in Drive as `Design Name (Xk-Yk)`.
2. 155 properly named photos have no price (sequence sheet, cut outs, helium, some single frame and welcome arch). Add a price to the name or folder.
3. ~~Website vs folder prices~~. **Decided:** folder prices only; the website is ignored.
4. Is "Bunches (40 per bunch)" ₹40 per bunch? Is there a minimum quantity? (Those files have generic names, so they're excluded anyway.)
5. Many photos show customers' children's names on the backdrop (for example "Shrihan 3"). This is common for portfolios, but the client should be comfortable with the bot sending them to strangers.
