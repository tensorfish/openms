# Windows setup

Install Git, [Bun](https://bun.sh/docs/installation), and Docker Desktop with its Linux container engine. Open a new PowerShell window after installation so it sees the updated executable paths. Run the commands below from the repository root.

## First-time setup

Install dependencies and create local settings without overwriting existing files:

```powershell
bun install --frozen-lockfile --ignore-scripts
foreach ($scope in @('server', 'client', 'studio')) {
    if (-not (Test-Path ".env.$scope")) {
        Copy-Item ".env.$scope.example" ".env.$scope"
    }
}
```

The browser game does not need dependency installation scripts. Browser automation tooling may need a separately installed browser.

Obtain the original assets as described in [Inputs](inputs.md). With a ZIP viewer, copy **only the 17 `.wz` files** directly inside `Maplestory-Client/` into `artifacts/Maplestory-Client/`. Do not unpack or run the Windows executables. Delete the downloaded ZIP after copying the data files. The application does not need the original EXE or DLL files.

Verify the retained data against the repository manifest before conversion:

```powershell
$assets = 'artifacts/Maplestory-Client'
$manifest = Get-Content docs/input-manifest.json -Raw | ConvertFrom-Json
$archives = @($manifest | Where-Object { $_.file -cmatch '^[A-Za-z]+\.wz$' })
if ($archives.Count -ne 17) { throw 'Unexpected WZ manifest.' }
foreach ($archive in $archives) {
    $path = Join-Path $assets $archive.file
    $file = Get-Item -LiteralPath $path -ErrorAction Stop
    $hash = Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop
    if ($file.Length -ne $archive.bytes -or $hash.Hash -ne $archive.sha256) {
        throw "Asset mismatch: $($archive.file)"
    }
}
bun extract --assets $assets
```

Wait for `Extraction succeeded`. Later launches reuse `client/public/generated/` and the extraction cache. Git preserves LF line endings in the imported portal programs because the compiler verifies their original bytes. Do not change `core.autocrlf` globally to work around an extraction hash failure.

Start Docker Desktop and wait for the engine, then initialize the database:

```powershell
docker desktop start --timeout 60
docker info
docker compose -f infra/compose.yaml up -d --build --wait --wait-timeout 90
bun run migrate --database-url postgres://openms:openms_local_only@127.0.0.1:55432/openms
```

Stop and resolve any failed command before continuing. Apply migrations again after SQL updates. The launcher does not apply schema changes. These commands use the published local development database settings; custom database settings must match `.env.server` and Compose.

## Start the game

```powershell
.\tools\start-local.ps1
```

The launcher checks prerequisites, starts Docker if its engine is unavailable, waits for PostgreSQL health, then starts the server and client as hidden background processes. It waits for their API readiness before opening [the game](http://127.0.0.1:3102). Sign in with `player / password` or `admin / password`, unless you configured `OPENMS_DEV_PASSWORD`, and select a character.

Run it again to reuse responsive services. Use `-NoBrowser` to skip opening a browser and `-TimeoutSeconds 240` to allow more time for service startup. For custom local ports, pass `-ServerUrl` and `-ClientUrl` matching your service settings. These flags control readiness checks and the browser URL; they do not edit `.env` files. LAN and production hosting use the [ordinary service commands](development.md).

Logs and process IDs are stored under ignored `artifacts/local/`. An unsuccessful launch reports the relevant log paths. If startup times out, inspect those logs before retrying, since the process may still be starting. Existing services are not restarted by the launcher. For development sessions where you frequently change code, run `bun run server:dev` and `bun run client:dev` in separate terminals and use Ctrl+C to stop each before restarting it. Closing the browser does not stop background services or PostgreSQL.

## Docker startup failures

An open Docker Desktop window does not mean its Linux engine is running. Check `docker info` before starting Compose. For a database failure, inspect `docker compose -f infra/compose.yaml logs postgres`.

On one Windows installation with Docker Desktop 4.53.0, repeated startup failures came from inaccessible stale Unix socket files. The backend log under `%LOCALAPPDATA%\Docker\log\host\com.docker.backend.exe.log` named `Docker\run\dockerInference` and `docker-secrets-engine\engine.sock`, reporting that the file could not be accessed by the system.

For that exact failure, recovery required quitting Docker Desktop, confirming its backend processes had exited, verifying the affected folders contained only the named transient sockets, and renaming those folders to backups before restarting Docker. This is a diagnosis-specific repair, not a routine startup step. Keep Docker's data, settings, credentials and volumes intact. The launcher reports failure and leaves this repair to the operator.
