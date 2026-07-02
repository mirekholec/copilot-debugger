# Publikace Copilot Debugger na npm

Tento návod popisuje publikaci balíčku `copilot-debugger`, který po instalaci zpřístupní příkaz:

```bash
npx copilot-debugger
```

## 1. Zkontroluj metadata balíčku

Otevři `package.json` a zkontroluj hlavně:

- `name`: `copilot-debugger`
- `version`: aktuální verze, například `0.1.0`
- `description`: krátký popis aplikace
- `bin`: příkaz `copilot-debugger`
- `repository`, `homepage`, `bugs`: správné GitHub URL
- `license`: `MIT`

## 2. Ověř dostupnost názvu na npm

```bash
npm view copilot-debugger version
```

Očekávaný výsledek před první publikací je `404 Not Found`. Znamená to, že balíček pod tímto názvem zatím na npm neexistuje nebo k němu nemáš přístup.

Pokud příkaz vrátí číslo verze, název už existuje. V tom případě buď použij jiný název, nebo publikuj jen pokud balíček vlastníš.

## 3. Přihlas se do npm

```bash
npm login
```

Potom ověř přihlášení:

```bash
npm whoami
```

Příkaz má vypsat tvoje npm uživatelské jméno.

## 4. Ověř TypeScript

```bash
npm run typecheck
```

Publikuj až ve chvíli, kdy typecheck projde bez chyb.

## 5. Sestav produkční balíček

```bash
npm run build
```

Build vytvoří:

- `dist/client` pro React UI
- `dist/server` pro Node/Express server a CLI entrypoint

## 6. Zkontroluj obsah npm balíčku

```bash
npm pack --dry-run
```

Zkontroluj, že výpis obsahuje jen očekávané soubory, hlavně:

- `dist/client/index.html`
- `dist/client/assets/*`
- `dist/server/cli.js`
- `dist/server/index.js`
- `README.md`
- `LICENSE`
- `package.json`

Ve výpisu musí být:

```text
name: copilot-debugger
filename: copilot-debugger-0.1.0.tgz
```

## 7. Publikuj první verzi

```bash
npm publish
```

U nescopeovaného balíčku `copilot-debugger` není potřeba `--access public`.

Pokud máš na npm zapnuté 2FA, npm si při publikaci vyžádá jednorázový kód.

## 8. Ověř publikovanou verzi

Po publikaci ověř metadata:

```bash
npm view copilot-debugger version
```

Potom ověř spuštění přes `npx`:

```bash
npx copilot-debugger
```

Aplikace se má spustit na:

```text
http://127.0.0.1:4317
```

CLI má zároveň automaticky otevřít prohlížeč.

## 9. Test bez automatického otevření prohlížeče

Pro rychlé ověření serveru bez otevření prohlížeče použij:

```bash
COPILOT_DEBUGGER_OPEN=0 PORT=4330 npx copilot-debugger
```

V druhém terminálu ověř API:

```bash
curl http://127.0.0.1:4330/api/health
```

Očekávaný výsledek je JSON s `ok: true`.

## 10. Publikace další verze

Před další publikací zvedni verzi:

```bash
npm version patch
```

Pro větší změny použij podle potřeby:

```bash
npm version minor
npm version major
```

Potom znovu spusť:

```bash
npm run typecheck
npm run build
npm pack --dry-run
npm publish
```

## Poznámky

- `npm publish` nejde opakovat se stejnou verzí. Před každou další publikací musíš změnit `version` v `package.json`.
- `npm pack --dry-run` je poslední kontrola před publikací. Když v něm vidíš nečekané soubory, uprav `files` v `package.json`.
- Pokud `npm audit` hlásí zranitelnosti, neřeš je automaticky přes `npm audit fix --force` bez kontroly dopadu. Může změnit major verze závislostí.