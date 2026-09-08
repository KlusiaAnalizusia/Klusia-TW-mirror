# Kopia danych świata — instrukcja

Repozytorium pobiera pliki mapy Plemion raz na godzinę i publikuje je jako JSON
pod stałym adresem. Twoje skrypty czytają potem z tego adresu, a nie z serwera gry.

Wszystko działa na darmowym GitHubie: Actions uruchamiają zadanie, Pages je hostują.
Nie ma serwera do utrzymania, nie ma bazy, nie ma kosztów.

## Co jest w środku

```
worlds.json                     lista światów do pobierania
scripts/fetch.mjs               pobieranie, konwersja, strona statusu
.github/workflows/mirror.yml    harmonogram i publikacja
test/run-test.mjs               test lokalny na sztucznych danych
```

Efektem jednego przebiegu jest katalog `public/`:

```
public/index.html               strona statusu (podgląd, co i kiedy się pobrało)
public/index.json               spis światów i plików
public/pl232/villages.json      id, nazwa, x, y, gracz, punkty, bonus
public/pl232/players.json       id, nazwa, plemię, wioski, punkty, ranking
public/pl232/tribes.json        id, nazwa, tag, członkowie, wioski, punkty…
public/pl232/conquers.json      wioska, czas, nowy właściciel, poprzedni
public/pl232/kills_att.json     kill_att / kill_def / kill_all
public/pl232/config.xml         interface.php?func=get_config, bez zmian
public/pl232/unit_info.xml      prędkości jednostek, bez zmian
public/pl232/meta.json          co się udało pobrać i kiedy
```

Każdy JSON ma pola `fields` i `rows` — kolejność kolumn odczytujesz z pliku,
więc zmiana po stronie gry nie wywróci skryptu po cichu.

---

## Krok po kroku

### 1. Repozytorium

Na GitHubie: **New repository** → nazwa np. `tw-mirror` → **Public** → Create.

Publiczne, bo wtedy minuty Actions są darmowe bez limitu (prywatne mają 2000 minut
miesięcznie, a to zadanie zjada ok. 700). Dane i tak są publiczne — to te same
pliki, które każdy może pobrać z serwera gry.

### 2. Wgranie plików

Na stronie repozytorium: **Add file → Upload files**, przeciągnij zawartość tej
paczki, **Commit changes**.

Jeśli wgrywasz przez przeglądarkę, upewnij się, że plik `mirror.yml` wylądował
w `.github/workflows/` — GitHub czasem gubi katalogi zaczynające się od kropki.
Gdyby tak się stało, użyj **Add file → Create new file** i wpisz w nazwę
`.github/workflows/mirror.yml`, a treść wklej.

### 3. Włączenie Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

To wszystko. Nie wybieraj gałęzi ani katalogu — publikacja idzie prosto z zadania.

### 4. Dwie zmienne

**Settings → Secrets and variables → Actions → zakładka Variables → New variable:**

| Nazwa | Wartość |
|---|---|
| `SITE_URL` | `https://TWOJA-NAZWA.github.io/tw-mirror` |
| `CONTACT` | adres e-mail do kontaktu |

`SITE_URL` służy do dwóch rzeczy: wpisania adresu na stronie statusu i odzyskania
poprzednich danych, gdy jedno pobranie padnie. `CONTACT` trafia do nagłówka
`User-Agent`, żeby po drugiej stronie było widać, kto pobiera i jak się odezwać.
To zwykła uprzejmość wobec serwera gry i warto to mieć wpisane.

Dokładny adres zobaczysz po pierwszej publikacji w **Settings → Pages**.

### 5. Lista światów

Edytuj `worlds.json`:

```json
{ "worlds": ["pl232"] }
```

Każdy świat to jedno pobranie na godzinę — dopisuj tylko te, których naprawdę używasz.

### 6. Pierwsze uruchomienie

**Actions → Kopia danych świata → Run workflow.** Przebieg trwa około minuty.
Potem wejdź na `SITE_URL` — powinna się otworzyć strona statusu z listą plików
i liczbą wierszy. Jeśli liczba wiosek zgadza się z tym, co widzisz w grze, działa.

Od tej pory zadanie startuje samo o :17 każdej godziny.

---

## Podłączenie skryptu

W nagłówku userscriptu:

```
// @connect      TWOJA-NAZWA.github.io
```

Dalej `GM_xmlhttpRequest` na `SITE_URL/pl232/villages.json` zamiast na
`/map/village.txt`. Pola czytasz przez `fields.indexOf('x')`, nie przez sztywne
indeksy. Warto zapamiętać nagłówek `ETag` i wysyłać go jako `If-None-Match` —
gdy dane się nie zmieniły, wraca 304 i nic się nie pobiera.

Po tej zmianie BigBrother przestaje dotykać serwera gry całkowicie: mapa, gracze,
plemiona, przejęcia, statystyki bojowe, konfiguracja i prędkości jednostek są
w kopii. Zostaje tylko to, co czytasz z otwartej strony gry — czyli nic dodatkowego.

---

## O czym warto wiedzieć

**Limit jest po Twojej stronie.** Dokumentacja pozwala pobierać pliki mapy raz na
godzinę i harmonogram jest ustawiony dokładnie tak. Jeśli dopiszesz drugi cron
albo będziesz często klikać „Run workflow", limit przestanie być zachowany.

**Cron w Actions bywa opóźniony** o kilka–kilkanaście minut przy dużym obciążeniu
GitHuba. Dla danych, które i tak odświeżają się co godzinę, to bez znaczenia.

**Zadania cykliczne wyłączają się po 60 dniach** bez żadnego commita w repozytorium.
GitHub przysyła wtedy maila i wystarczy kliknąć „Enable workflow".

**Jedno nieudane pobranie nie kasuje danych.** Skrypt sięga wtedy po poprzednią
opublikowaną wersję pliku i publikuje ją ponownie, oznaczając na stronie statusu
jako „poprzednie dane". Dopiero gdy nie uda się nic, przebieg kończy się błędem,
a poprzednia publikacja zostaje nietknięta.

**To nie zastępuje zgody supportu.** Zmienia się tylko to, skąd biorą się dane —
ruch przestaje wychodzić z Twojego IP i Twojej sesji. Kwestia zatwierdzenia
skryptu jako takiego zostaje osobno.

---

## Test lokalny

```
node test/run-test.mjs
```

Podstawia sztuczne pliki świata zamiast sieci i sprawdza cały pipeline: gzip,
kodowanie nazw z polskimi znakami, typy liczbowe, zmienną liczbę kolumn w
`conquer.txt`, zachowanie przy błędzie jednego pliku i wygenerowaną stronę statusu.
Nie dotyka serwera gry, więc możesz go uruchamiać do woli.
