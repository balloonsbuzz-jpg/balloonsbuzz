-- Seed 003: occasions, packages (design categories), themes + aliases. Idempotent.
-- Package price ranges are DERIVED FROM THE CLIENT'S DRIVE FOLDER/FILE NAMES
-- (website prices are ignored). All rows: price_confirmed = false  => TODO: confirm with client.

-- ── occasions ─────────────────────────────────────────────────
INSERT INTO occasions (tenant_id, key, name, aliases, sort_order)
SELECT t.id, o.key, o.name, o.aliases, o.sort_order
FROM tenants t CROSS JOIN (VALUES
  ('birthday',        'Birthday',          ARRAY['bday','birthday party','kids birthday','1st birthday','first birthday','50th birthday','adult birthday','hbd'], 10),
  ('baby_shower',     'Baby Shower',       ARRAY['babyshower','seemantham','godh bharai','valaikappu'], 20),
  ('welcome_baby',    'Welcome Baby',      ARRAY['welcome home baby','baby welcome','newborn welcome'], 30),
  ('cradle_ceremony', 'Cradle Ceremony',   ARRAY['naming ceremony','barasala','namkaran','cradle'], 40),
  ('anniversary',     'Anniversary',       ARRAY['wedding anniversary','romantic','couple surprise'], 50),
  ('wedding',         'Wedding',           ARRAY['marriage','engagement','reception','haldi','mehendi'], 60),
  ('congratulations', 'Congratulations',   ARRAY['celebration','cheers','promotion','retirement'], 70),
  ('gender_reveal',   'Gender Reveal',     ARRAY['gender reveal party'], 80),
  ('bridal_shower',   'Bridal Shower',     ARRAY['bachelorette'], 90),
  ('surprise',        'Surprise',          ARRAY['car trunk surprise','room surprise'], 100),
  ('corporate',       'Corporate / Office',ARRAY['office','corporate event','company event','launch'], 110)
) AS o(key, name, aliases, sort_order)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, key) WHERE deleted_at IS NULL DO NOTHING;

-- ── packages (design categories) ─────────────────────────────
-- price_min/max: observed range in the Drive names (sample size in the comment).
INSERT INTO packages (tenant_id, key, name, kind, price_min, price_max, unit_label, folder_names, sort_order, description)
SELECT t.id, p.key, p.name, p.kind, p.pmin, p.pmax, p.unit, p.folders, p.sort, p.descr
FROM tenants t CROSS JOIN (VALUES
  ('basic',            'Basic Decor',            'package', 3500,  5000,  NULL::text, ARRAY['BASIC (3.5-5k)','basic baby shower(3.5k-5k)','basic welcome baby(3.5k-5k)'], 10, 'n=106 priced photos'),
  ('balloon_bunches',  'Balloon Bunches',        'package', 3500,  5000,  NULL, ARRAY['balloon bunches(3.5k-5k)'], 20, 'n=17'),
  ('car_trunk',        'Car Trunk Decor',        'package', 2500,  3500,  NULL, ARRAY['car trunk decor(2.5k-3.5k)'], 30, 'folder price'),
  ('wall_decor',       'Wall Decor',             'package', 4000,  4500,  NULL, ARRAY['baby shower/wall (4k-4.5k)'], 40, 'folder price'),
  ('ring_frame',       'Ring Frame',             'package', 4000,  15000, NULL, ARRAY['RING frame','ring baby shower','baby shower/ring frame(5.5k-7k)'], 50, 'n=80'),
  ('single_frame',     'Single Frame',           'package', 7000,  8000,  NULL, ARRAY['single frame','baby shower/single frame'], 60, 'n=1 only - TODO confirm'),
  ('two_frames',       '2 Frames Decor',         'package', 6500,  20000, NULL, ARRAY['2 frames decor'], 70, 'n=67'),
  ('three_frames',     '3 Frames Decor',         'package', 10000, 25000, NULL, ARRAY['3 frame decor'], 80, 'n=59'),
  ('four_plus_frames', '4+ Frames Decor',        'package', 15000, 35000, NULL, ARRAY['more then 3 frames'], 90, 'n=10'),
  ('big_frame',        'Big Frame',              'package', 8000,  30000, NULL, ARRAY['big frame'], 100, 'n=19'),
  ('semi_arch',        'Semi Arch',              'package', 6000,  10000, NULL, ARRAY['semi arch(6k-10k)'], 110, 'folder price'),
  ('welcome_arch',     'Welcome Arch',           'package', NULL,  NULL,  NULL, ARRAY['welcome arch'], 120, 'no price in Drive - TODO'),
  ('moon_theme',       'Moon Theme',             'package', 7500,  10000, NULL, ARRAY['moon theme (7.5k-10k)'], 130, 'folder price'),
  ('cradle_ceremony',  'Cradle Ceremony Decor',  'package', 8000,  10000, NULL, ARRAY['cradle ceremony'], 140, 'n=4'),
  ('twin_birthday',    'Twin Birthday Decor',    'package', 10000, 20000, NULL, ARRAY['twin birthday'], 150, 'n=4'),
  ('congratulations',  'Congratulations Decor',  'package', 8000,  9000,  NULL, ARRAY['congulations'], 160, 'n=1'),
  ('helium_decor',     'Helium Decor',           'package', NULL,  NULL,  NULL, ARRAY['helium decor'], 170, 'no price in Drive - TODO'),
  ('bunch_unit',       'Balloon Bunch (per bunch)','unit',  40,    40,    'bunch', ARRAY['Bunches( 40per bunch)'], 180, '₹40 per bunch per folder name - TODO confirm + min qty'),
  ('addon_cutout',     'Cut-outs (add-on)',      'addon',   NULL,  NULL,  NULL, ARRAY['cut outs'], 190, 'no price in Drive - TODO'),
  ('addon_sequence_sheet','Sequin Sheet Backdrop (add-on)','addon', NULL, NULL, NULL, ARRAY['sequence sheet'], 200, 'no price in Drive - TODO')
) AS p(key, name, kind, pmin, pmax, unit, folders, sort, descr)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, key) WHERE deleted_at IS NULL DO NOTHING;

-- ── themes ───────────────────────────────────────────────────
INSERT INTO themes (tenant_id, key, name)
SELECT t.id, th.key, th.name
FROM tenants t CROSS JOIN (VALUES
  ('animal','Animal / Jungle'), ('angry_birds','Angry Birds'), ('avengers','Avengers / Superheroes'),
  ('barbie','Barbie'), ('batman','Batman'), ('boss_baby','Boss Baby'), ('butterfly','Butterfly'),
  ('candy','Candy / Cupcake'), ('cars','Cars & Racing'), ('vehicles','Vehicles & Construction'),
  ('train','Train / Thomas & Friends'), ('cocomelon','Cocomelon'), ('dinosaur','Dinosaur'),
  ('elephant','Elephant'), ('fairy','Fairy'), ('football','Football'), ('frozen','Frozen'),
  ('halloween','Halloween'), ('harry_potter','Harry Potter'), ('hello_kitty','Hello Kitty'),
  ('kpop','K-Pop'), ('lego','Lego'), ('masha_bear','Masha & the Bear'), ('mermaid','Mermaid'),
  ('mickey_minnie','Mickey & Minnie'), ('minions','Minions'), ('moana','Moana'), ('moon_clouds','Moon & Clouds'),
  ('musical','Musical'), ('panda','Panda'), ('paw_patrol','Paw Patrol'), ('peppa_pig','Peppa Pig'),
  ('powerpuff','Powerpuff Girls'), ('princess','Princess'), ('rabbit','Rabbit / Bunny'), ('roblox','Roblox'),
  ('spiderman','Spiderman'), ('tangled','Tangled (Rapunzel)'), ('teddy','Teddy Bear'), ('tom_jerry','Tom & Jerry'),
  ('transformers','Transformers'), ('underwater','Underwater / Ocean'), ('unicorn','Unicorn'),
  ('winnie_pooh','Winnie the Pooh'), ('happy_birthday','Happy Birthday (classic)'), ('twins','Twins / Mixed')
) AS th(key, name)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, key) WHERE deleted_at IS NULL DO NOTHING;

-- ── theme aliases: Drive folder spellings (incl. typos) + customer phrasing ──
INSERT INTO theme_aliases (tenant_id, theme_id, alias)
SELECT th.tenant_id, th.id, a.alias
FROM themes th
JOIN tenants t ON t.id = th.tenant_id AND t.slug = 'balloonsbuzz'
JOIN (VALUES
  ('animal','animal'),('animal','animal theme'),('animal','jungle'),('animal','jungle theme'),('animal','safari'),('animal','wild'),
  ('angry_birds','angry bird'),('angry_birds','angry birds'),
  ('avengers','avengers'),('avengers','avengers theme'),('avengers','marvel'),('avengers','superhero'),('avengers','super hero'),
  ('barbie','barbie'),('barbie','birbe'),('barbie','birbe theme'),
  ('batman','batman'),('batman','bat man'),
  ('boss_baby','boss baby'),('boss_baby','baby boss'),
  ('butterfly','butterfly'),('butterfly','butterfly theme'),
  ('candy','cup cake'),('candy','cup cakes'),('candy','cupcake'),('candy','candy'),('candy','candy theme'),('candy','candy cupcake'),
  ('cars','car'),('cars','cars'),('cars','car theme'),('cars','cars theme'),('cars','flex car theme'),('cars','race track'),('cars','racing'),('cars','bikers theme'),
  ('vehicles','vehicals'),('vehicles','vechical'),('vehicles','vehicle'),('vehicles','vehicles'),('vehicles','construction'),('vehicles','construction theme'),('vehicles','transport'),('vehicles','cars & transport'),
  ('train','train'),('train','train theme'),('train','thomas and frds'),('train','thomas'),('train','thomas and friends'),
  ('cocomelon','cocomelon'),('cocomelon','coco melon'),
  ('dinosaur','dinosaur'),('dinosaur','dinosour'),('dinosaur','dinosor'),('dinosaur','dino'),('dinosaur','dinosaur theme'),
  ('elephant','elephant'),('elephant','elephant theme'),
  ('fairy','fairy'),('fairy','fairy theme'),('fairy','fairy tale'),('fairy','fairy tale theme'),
  ('football','football'),('football','foot ball'),('football','soccer'),
  ('frozen','frozen'),('frozen','elsa'),
  ('halloween','halloween'),('halloween','hallowen'),
  ('harry_potter','harry potter'),
  ('hello_kitty','hello kitty'),('hello_kitty','hello kitty thee'),
  ('kpop','k pop'),('kpop','kpop'),('kpop','k-pop'),('kpop','bts'),
  ('lego','lego'),
  ('masha_bear','masha & bear'),('masha_bear','masha and bear'),('masha_bear','masha theme'),('masha_bear','masha'),
  ('mermaid','mermaid'),('mermaid','mermaid theme'),
  ('mickey_minnie','mickey mouse'),('mickey_minnie','micky mouse'),('mickey_minnie','mickey'),('mickey_minnie','micky'),('mickey_minnie','minnie'),('mickey_minnie','micky minnie'),('mickey_minnie','micky - minnie theme'),
  ('minions','minions'),('minions','minion'),
  ('moana','moana'),
  ('moon_clouds','moon theme'),('moon_clouds','moon'),('moon_clouds','clouds'),
  ('musical','musical theme'),('musical','musical'),('musical','music'),
  ('panda','panda'),
  ('paw_patrol','paw patrol'),('paw_patrol','paw petrol'),('paw_patrol','paw patrol theme'),
  ('peppa_pig','peppa pig'),('peppa_pig','pegga pig'),('peppa_pig','peppa'),
  ('powerpuff','power puff girl'),('powerpuff','powerpuff girls'),('powerpuff','powrepuff girls'),('powerpuff','powerpuff'),
  ('princess','princess'),('princess','princess theme'),('princess','disney princess'),('princess','disney princess theme'),('princess','castle'),('princess','castel'),
  ('rabbit','rabbit'),('rabbit','rabbit theme'),('rabbit','bunny'),
  ('roblox','roblox'),('roblox','roblex'),
  ('spiderman','spiderman'),('spiderman','spider man'),('spiderman','sipder man'),('spiderman','spidey'),('spiderman','spiderman theme'),
  ('tangled','tangled (rapunzel)'),('tangled','tangled'),('tangled','rapunzel'),
  ('teddy','teddy'),('teddy','teddy bear'),
  ('tom_jerry','tom & jerry'),('tom_jerry','tom&jerry'),('tom_jerry','tom and jerry'),('tom_jerry','tom & jerry theme'),
  ('transformers','transformer'),('transformers','transformers'),('transformers','trasformer'),('transformers','transformers theme'),
  ('underwater','under water'),('underwater','underwater'),('underwater','under water theme'),('underwater','underwater theme'),('underwater','sea water theme'),('underwater','ocean'),('underwater','oscan'),('underwater','sea'),
  ('unicorn','unicorn'),
  ('winnie_pooh','winnie the pooh'),('winnie_pooh','pooh'),
  ('happy_birthday','happy birthday'),('happy_birthday','hbd'),
  ('twins','twin birthday'),('twins','twins decor'),('twins','mixed theme'),('twins','mixed theme decor')
) AS a(theme_key, alias) ON a.theme_key = th.key
ON CONFLICT (tenant_id, alias) DO NOTHING;
