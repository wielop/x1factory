# Zasady gry X1Factory Seasons

X1Factory Seasons to sezonowa gra punktowa dla uzytkownikow X1Factory. Bot Telegram zlicza wybrane aktywnosci zarejestrowanego portfela i tworzy ranking sezonu.

## Sezony

- Standardowy sezon trwa 21 dni.
- Standardowa przerwa pomiedzy sezonami trwa 7 dni.
- Punkty sezonowe sa naliczane tylko w aktywnym oknie sezonu.
- `Season 0` jest sezonem testowym. Oficjalny `Season 1` startuje od zera.

## Rejestracja

- Uczestnik musi uruchomic bota i uzyc komendy `/register`.
- Bot zapisuje profil Telegram oraz aktywny portfel.
- Jeden portfel moze byc przypisany tylko do jednego uzytkownika.
- Zmiana portfela przez zwyklego uzytkownika jest zablokowana i wymaga admina.
- Rejestracja portfela w sezonie daje 50 punktow.

## Punktowane aktywnosci

### Zakup rigow

- Starter rig purchase: 20 punktow
- Pro rig purchase: 75 punktow
- Industrial rig purchase: 150 punktow

### Odnowienia

- Starter renewal: 10 punktow
- Pro renewal: 40 punktow
- Industrial renewal: 80 punktow

### Dzienne aktywne rigi

Punkty za dzienna aktywnosc sa naliczane dopiero po tym, jak rig byl aktywny co najmniej 24 godziny od `startTs`.

- Starter daily active: 2 punkty
- Pro daily active: 8 punktow
- Industrial daily active: 20 punktow

### Dzienne claimy MIND

Claimy MIND sa liczone jako dzienna suma, a nie jako pojedyncza transakcja. Bot dolicza tylko roznice do aktualnie osiagnietego progu.

- Od 0.000000001 MIND: 5 punktow
- Od 50 MIND: 15 punktow
- Od 100 MIND: 30 punktow
- Od 250 MIND: 80 punktow
- Od 500 MIND: 150 punktow

Maksymalna liczba punktow za dzienny claim MIND to 150.

### Stake MIND

Stake jest liczony jako postep ponad baseline sezonu. Baseline jest ustalany dla uzytkownika w danym sezonie, a punkty sa przyznawane tylko za wzrost ponad ten poziom.

- Od 100 MIND ponad baseline: 25 punktow
- Od 500 MIND ponad baseline: 100 punktow
- Od 1000 MIND ponad baseline: 250 punktow
- Od 2500 MIND ponad baseline: 600 punktow
- Od 5000 MIND ponad baseline: 1200 punktow

Milestone stake jest przyznawany tylko raz w sezonie.

## Ranking

- Ranking sezonowy pokazuje punkty z aktualnego sezonu.
- Ranking all-time pomija testowy `Season 0`.
- Przy remisie wyzej jest uzytkownik z wczesniejszym ostatnim punktowanym zdarzeniem, a nastepnie nizszym ID uzytkownika.

## Bezpieczenstwo naliczania

- Bot nie nalicza punktow za transakcje spoza aktywnego okna sezonu.
- Transakcje bez `blockTime` sa traktowane diagnostycznie i nie daja automatycznych punktow.
- Ten sam event transakcyjny nie powinien naliczyc punktow drugi raz.
