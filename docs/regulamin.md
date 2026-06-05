# Regulamin X1Factory Seasons

Ten dokument jest operacyjnym regulaminem gry punktowej X1Factory Seasons. Przed oficjalna publikacja powinien zostac sprawdzony przez osobe odpowiedzialna za komunikacje i kwestie prawne projektu.

## 1. Organizator i cel gry

1. X1Factory Seasons jest sezonowa gra rankingowa oparta o aktywnosc uzytkownikow X1Factory.
2. Celem gry jest nagradzanie aktywnosci w ekosystemie przez punkty sezonowe i ranking.
3. Gra dziala przez bota Telegram oraz scanner aktywnosci portfeli.

## 2. Uczestnictwo

1. Uczestnikiem moze byc uzytkownik Telegram, ktory zarejestruje portfel w bocie.
2. Uczestnik odpowiada za podanie poprawnego adresu portfela.
3. Jeden portfel moze byc przypisany tylko do jednego uzytkownika.
4. Zmiana portfela po rejestracji wymaga interwencji administratora.

## 3. Sezony

1. Standardowy sezon trwa 21 dni.
2. Standardowa przerwa pomiedzy sezonami trwa 7 dni.
3. Organizator moze uruchomic sezon testowy.
4. `Season 0` jest sezonem testowym i nie musi byc uwzgledniany w oficjalnych wynikach all-time.
5. Oficjalny `Season 1` startuje od zera.

## 4. Punkty

1. Punkty sa naliczane zgodnie z zasadami gry opisanymi w `docs/zasady-gry.md`.
2. Punkty moga byc naliczane automatycznie przez scanner albo manualnie przez administratora.
3. Automatyczne punkty sa naliczane tylko dla aktywnosci mieszczacych sie w oknie aktywnego sezonu.
4. Transakcje bez wiarygodnego czasu bloku moga zostac pominiete przez automatyczne naliczanie.
5. Ten sam event nie powinien byc liczony wielokrotnie.

## 5. Ranking

1. Ranking sezonowy obejmuje punkty z aktualnego sezonu.
2. Ranking all-time obejmuje punkty z oficjalnych sezonow i pomija testowy `Season 0`.
3. Przy remisie decyduje wczesniejszy czas ostatniego punktowanego zdarzenia, a potem kolejnosc techniczna w bazie.

## 6. Korekty administracyjne

1. Administrator moze dodac albo odjac punkty, jesli wymaga tego korekta techniczna, blad scannera lub decyzja organizatora.
2. Administrator moze zaktualizowac portfel uzytkownika.
3. Administrator moze uruchomic, zakonczyc albo monitorowac sezon.
4. Administrator moze recznie przeskanowac portfel albo uruchomic jednorazowy przebieg scannera.

## 7. Naduzycia

1. Proby manipulacji rejestracja, portfelami, botem lub aktywnoscia moga skutkowac korekta punktow albo wykluczeniem.
2. Organizator moze odrzucic aktywnosc, ktora wynika z bledu technicznego, exploitu lub dzialania sprzecznego z celem gry.

## 8. Awarie i dane

1. Bot i scanner moga dzialac z opoznieniem wynikajacym z infrastruktury Telegram, RPC, bazy danych lub sieci.
2. W przypadku awarii organizator moze odtworzyc punkty na podstawie danych onchain, logow i danych w bazie.
3. Uczestnik powinien zglaszac niescislosci administratorowi z podaniem portfela i przyblizonego czasu zdarzenia.

## 9. Zmiany regulaminu

1. Organizator moze aktualizowac zasady gry i regulamin przed startem kolejnego sezonu.
2. Zmiany w trakcie aktywnego sezonu powinny byc ograniczone do korekt bledow, bez nieuzasadnionego pogarszania sytuacji uczestnikow.
