# Sven z'n uren

Een eenvoudige PWA om gewerkte uren en het verwachte bruto loon bij te houden.
Geen build-stap, geen account: gewoon statische bestanden.

## Online zetten (HTTPS is verplicht)

**Optie 1, Netlify Drop (snelst, geen account nodig om te proberen)**
1. Ga naar https://app.netlify.com/drop
2. Sleep de map `sven-uren` (uitgepakt) in het venster.
3. Je krijgt meteen een https-adres. Maak een gratis account aan om de site te bewaren.

**Optie 2, GitHub Pages**
1. Maak een nieuwe repository, bijvoorbeeld `sven-uren`.
2. Upload alle bestanden uit deze map naar de hoofdmap van de repository (inclusief `.nojekyll`).
3. Ga naar Settings → Pages, kies bij *Source* "Deploy from a branch", branch `main`, map `/ (root)`.
4. Na een minuut staat de app op `https://<gebruikersnaam>.github.io/sven-uren/`.

## Op de iPhone zetten
1. Open het adres in **Safari**.
2. Tik op de deelknop (vierkantje met pijl omhoog).
3. Kies **Zet op beginscherm** en tik op **Voeg toe**.
4. Open de app voortaan via het icoon; hij opent als losse app en werkt daarna ook offline.

## Een nieuwe versie uitbrengen
Pas de bestanden aan en verhoog `VERSION` bovenin `sw.js` (bijv. `v1.0.1`).
De service worker ververst dan alleen de app-bestanden. Diensten, rooster en
instellingen staan in IndexedDB en blijven bij een update gewoon bewaard.

## Bestanden
- `index.html`, `styles.css`, `app.js` – de app
- `calc.js` – rekenregels (betaalde tijd, pauzes, loon, nachtdiensten)
- `db.js` – lokale opslag (IndexedDB)
- `sw.js` – service worker voor offline gebruik
- `manifest.webmanifest`, `icons/` – PWA-manifest en app-iconen (incl. Apple touch icon)

## Hoe er gerekend wordt
- Betaalde tijd = eindtijd − begintijd − onbetaalde pauze, op de milliseconde; alleen de weergave wordt afgerond op minuten/centen.
- Bij elke dienst wordt het uurloon van dat moment opgeslagen. Een nieuw uurloon verandert eerdere diensten niet.
- Een dienst telt mee in de week/maand waarin hij begint. Diensten over middernacht worden als één dienst gerekend.
- Geplande diensten (Rooster) tellen nooit mee als gewerkte uren.
- Het bedrag is een indicatie van het bruto loon, exclusief toeslagen, vakantiegeld en inhoudingen.

## Lettertypes
`fonts/` bevat Bricolage Grotesque en DM Sans (SIL Open Font License, zie de OFL-bestanden). Ze staan in de app zelf, zodat ze ook offline werken.
