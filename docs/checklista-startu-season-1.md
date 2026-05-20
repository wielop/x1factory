# Checklista startu Season 1

## Kod i release

- [ ] Review diff przed commitem.
- [ ] `npm run build` przechodzi.
- [ ] `npm audit --omit=dev` pokazuje `0 vulnerabilities`.
- [ ] `npx prisma validate` przechodzi.
- [ ] `npx prisma migrate status` pokazuje `Database schema is up to date!`.
- [ ] Commit release changes.
- [ ] Uruchomic proces produkcyjny po commicie.

## Baza danych

- [ ] Potwierdzic, ze `Season 0` zostaje sezonem testowym.
- [ ] Zakonczyc `Season 0` komenda `/admin_endseason`.
- [ ] Uruchomic oficjalny sezon komenda `/admin_startseason Season 1`.
- [ ] Potwierdzic przez `/admin_status`, ze aktywny jest tylko `Season 1`.
- [ ] Potwierdzic, ze ranking Season 1 zaczyna od zera.
- [ ] Potwierdzic, ze `/alltime` nie liczy `Season 0`.

## Bot Telegram

- [ ] `/start` odpowiada.
- [ ] `/help` dla zwyklego usera pokazuje tylko publiczne komendy.
- [ ] `/help` dla admina pokazuje publiczne i admin commands.
- [ ] `/register` zapisuje nowego usera i portfel.
- [ ] `/register` dla usera z portfelem dopisuje go do aktywnego sezonu.
- [ ] `/profile` pokazuje portfel, sezon, punkty i ostatnie eventy.
- [ ] `/season` pokazuje aktualny sezon.
- [ ] `/leaderboard` pokazuje ranking sezonu.
- [ ] `/alltime` pokazuje ranking bez `Season 0`.

## Admin

- [ ] `/admin_status` pokazuje aktywny sezon i top userow.
- [ ] `/admin_scanner_status` pokazuje parser confirmed i IDL path.
- [ ] `/admin_scanner_once` konczy sie bez bledow.
- [ ] `/admin_scan_wallet <wallet>` dziala dla znanego portfela.
- [ ] `/admin_set_wallet <telegram_id> <wallet>` dziala w razie korekty.
- [ ] `/admin_addpoints` i `/admin_removepoints` dzialaja na testowym userze.
- [ ] `/admin_broadcast` jest przetestowany tylko na malej grupie/testowym srodowisku.

## Scanner

- [ ] IDL jest ladowane z oczekiwanej sciezki.
- [ ] RPC host jest poprawny.
- [ ] Scanner automatyczny jest wlaczony (`X1_SCANNER_ENABLED=true`).
- [ ] Interwal jest ustawiony swiadomie (`X1_SCANNER_INTERVAL_SECONDS`).
- [ ] Pierwszy przebieg po starcie ma `errors=0`.
- [ ] Zakup riga nalicza punkty raz.
- [ ] Claim MIND nalicza dzienny prog i nie duplikuje punktow.
- [ ] Stake liczy wzrost ponad baseline sezonu.
- [ ] Daily active nalicza sie dopiero po 24 godzinach.

## Komunikacja

- [ ] Opublikowac `docs/zasady-gry.md`.
- [ ] Opublikowac `docs/instrukcja-gry.md`.
- [ ] Opublikowac `docs/regulamin.md` po finalnej akceptacji.
- [ ] Wyjasnic publicznie, ze `Season 0` byl testowy.
- [ ] Podac date i godzine startu Season 1.
