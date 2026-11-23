# 🏢 AI Kantoor

Een visueel kantoor op `localhost`. Elke Claude Code-chat die op je computer draait, is een medewerker met een eigen bureau. Boven het hoofd van elke medewerker staat:

- **wie het is**: een vaste naam, het project en de titel van de chat
- **wat die doet** en de **status**:
  - 🟢 **Aan het werk met: …** (bijvoorbeeld "bewerkt server.js" of "zoekt online: …")
  - 🟠 **Wacht op mij**: een vraag voor jou, toestemming nodig of een plan om goed te keuren
  - 🔵 **Klaar**
  - ⚪ **Slaapt**: de chat is al een tijd stil of gesloten

Subagents die een chat aan het werk zet, verschijnen als kleine **helpers** naast hun baas.

## Starten

Je hebt Node.js 18 of nieuwer nodig. Er hoeven geen packages geïnstalleerd te worden.

```bash
cd ai-office
node server.js          # open daarna http://localhost:4747
node server.js --demo   # met nep-medewerkers, om te zien hoe het eruitziet
```

## Exacte status met hooks (aanbevolen)

Zonder hooks leest het kantoor de sessiebestanden in `~/.claude` en leidt het de status daaruit af. Dat werkt meestal goed. Alleen "wacht op toestemming" is soms een schatting.

Met hooks meldt Claude Code zelf elk moment aan het kantoor, ook precies wanneer het op jouw toestemming wacht:

```bash
node install-hooks.js            # zet de hooks in ~/.claude/settings.json (er wordt eerst een backup gemaakt)
node install-hooks.js --remove   # haalt ze weer weg
```

Herstart daarna je open Claude Code-sessies. Staat het kantoor uit, dan doen de hooks niets en houden ze je ook niet op.

## Handig

- **Klik op een medewerker** voor details: je laatste opdracht, het laatste bericht en de map. Er is ook een knop om `claude --resume …` te kopiëren, en je kunt de medewerker een andere naam geven.
- **🔔 Meldingen** geeft een browsermelding zodra iemand op je wacht. Het tabblad toont ook het aantal, bijvoorbeeld `(2) wacht op jou`.
- **💤 Slapers** toont of verbergt gesloten en stille chats.
- Elke medewerker houdt zijn eigen bureau en naam. Die worden bewaard in `office-names.json`.

## Andere agents toevoegen

Elk script of elke tool kan zichzelf als medewerker melden:

```bash
curl -X POST localhost:4747/api/agents -H 'content-type: application/json' \
  -d '{"id":"import-bot","name":"Bot","title":"Nachtelijke import","status":"working","activity":"rijen inlezen"}'
```

`status` is `working`, `waiting`, `done` of `sleeping`. Een medewerker weghalen doe je met `DELETE /api/agents/import-bot`.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `4747` | poort van het kantoor (gebruik je hooks, zet dan ook `AI_OFFICE_PORT`) |
| `RECENT_HOURS` | `8` | gesloten chats tot zoveel uur oud blijven zichtbaar als slapend |
| `SLEEP_MINUTES` | `30` | een chat die klaar is en zo lang stil blijft, gaat slapen |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | waar Claude Code zijn sessies bewaart |

## Wat het wel en niet ziet

- ✅ Claude Code-sessies op deze computer: de terminal, de Code-tab in de desktop-app en IDE-extensies.
- ❌ Gewone chats op claude.ai en cloudsessies op claude.ai/code: die draaien niet op je computer.
- De server luistert alleen op `127.0.0.1`. Je sessie-inhoud gaat dus nergens naartoe.
