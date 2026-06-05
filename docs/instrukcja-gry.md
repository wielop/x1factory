# Instrukcja gry X1Factory Seasons

Ta instrukcja opisuje, jak dolaczyc do sezonu i sprawdzac swoje wyniki w bocie Telegram.

## 1. Uruchom bota

Otworz bota X1Factory Seasons na Telegramie i wyslij:

```text
/start
```

Bot pokaze podstawowe informacje o grze.

## 2. Zarejestruj profil i portfel

Wyslij:

```text
/register
```

Nastepnie wyslij adres swojego portfela X1/Solana jako zwykla wiadomosc.

Jesli portfel jest poprawny, bot zapisze go jako aktywny portfel i dopisze Cie do aktywnego albo najblizszego sezonu.

## 3. Graj przez aktywnosc na X1Factory

Po rejestracji bot moze naliczac punkty za:

- zakup rigow,
- odnowienia rigow,
- aktywne rigi po 24 godzinach,
- dzienne claimy MIND,
- wzrost stake MIND ponad baseline sezonu,
- rejestracje portfela w sezonie.

Nie trzeba recznie zglaszac standardowych eventow. Scanner bota wykrywa obslugiwane aktywnosci automatycznie.

## 4. Sprawdz sezon

Wyslij:

```text
/season
```

Zobaczysz nazwe sezonu, status, date startu, date konca, numer dnia i pozostaly czas.

## 5. Sprawdz profil

Wyslij:

```text
/profile
```

Zobaczysz:

- zapisany portfel,
- aktualny sezon,
- punkty sezonowe,
- aktualna pozycje,
- punkty all-time,
- ostatnie punktowane eventy.

## 6. Sprawdz ranking

Ranking aktualnego sezonu:

```text
/leaderboard
```

Ranking all-time:

```text
/alltime
```

Ranking all-time nie uwzglednia testowego `Season 0`.

## 7. Zmiana portfela

Zwykly uzytkownik nie moze samodzielnie zmienic portfela po rejestracji. Jesli wpisales zly portfel, skontaktuj sie z administratorem.

## 8. Najczestsze problemy

### Bot mowi, ze portfel jest juz zarejestrowany

Portfel moze byc przypisany tylko do jednego uzytkownika. Jesli to Twoj portfel, skontaktuj sie z administratorem.

### Punkty nie pojawily sie od razu

Scanner dziala cyklicznie. Niektore punkty pojawiaja sie dopiero po kolejnym przebiegu scannera.

### Daily active nie zostalo naliczone

Rig musi byc aktywny co najmniej 24 godziny od `startTs`.

### Stake nie dostal punktow

Stake liczy sie tylko jako wzrost ponad baseline sezonu. Stake istniejacy przed sezonem nie daje retroaktywnych punktow.
