# Quick Start

OpenMS is a MapleStory client rewritten in JavaScript, with a matching server reimplementation. It converts the original WZ assets into deterministic, content-addressed browser resources and runs the game in the browser, with the original Windows client's behaviour recovered from decompilation, Ghidra evidence and retained captures rather than copied from the original binaries. Rendering, input, animation, audio and world streaming are browser-owned, while [gameplay](server/protocol.md) and saved state remain server-authoritative. The reimplementation targets fidelity to the original client over convenience, and the [validation](validation-method.md) and [evidence](validation.md) records state which behaviours are proved and which remain unverified — notably original Windows visual and audio parity.

For native PowerShell and Docker Desktop, follow [Windows setup](windows-setup.md). It includes a launcher that waits for the database and game services and reuses existing assets.

On macOS with [Homebrew](https://brew.sh/):

```sh
# Install Bun, Podman, Compose and Git.
brew install oven-sh/bun/bun podman docker-compose git

# Create and start the Podman machine; skip init if it already exists.
podman machine init
podman machine start

# Clone the repository and install dependencies.
git clone https://github.com/tensorfish/openms.git
cd openms
bun install --frozen-lockfile

# Create local settings without overwriting existing files.
cp -n .env.server.example .env.server
cp -n .env.client.example .env.client
cp -n .env.studio.example .env.studio

# Download and unpack only WZ data beside the repository.
curl --fail --location --output ../Maplestory-Assets.zip \
  https://bucket.openms.dev/Maplestory-Assets.zip
unzip -n ../Maplestory-Assets.zip 'Maplestory-Client/*.wz' -d ..
rm ../Maplestory-Assets.zip

# Generate client/public/generated/ and wait for "Extraction succeeded".
bun extract --assets ../Maplestory-Client

# Start PostgreSQL and apply the database schema.
podman compose -f infra/compose.yaml up -d --build --wait --wait-timeout 90
bun run migrate --database-url postgres://openms:openms_local_only@127.0.0.1:55432/openms

# Terminal 1: start the server and wait for "authoritative server ready".
# Leave this running, then open a second terminal.
bun run server:dev

# Terminal 2: enter the same repository root and start the client.
bun run client:dev

# Open http://127.0.0.1:3102 in your browser.
# Sign in with admin / password or player / password, then select a character.
```

The ZIP also contains Windows executables that have triggered antivirus detections. The browser game needs only WZ data; see [Inputs](inputs.md) before downloading.

For other platforms, install [Bun](https://bun.sh/docs/installation), [Podman](https://podman.io/docs/installation) and a [Compose provider](https://docs.podman.io/en/latest/markdown/podman-compose.1.html); keep Git, `curl` and `unzip` available, then continue from checkout.

## Components

| Component | What it does                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun       | Installs dependencies and runs the tools, server and client development listener.                                                                                 |
| Assets    | The ZIP unpacks original WZ files into `../Maplestory-Client/`. Extraction converts them and the repository gameplay definitions into `client/public/generated/`. |
| Podman    | Runs PostgreSQL and retains its data in a persistent volume.                                                                                                      |
| Migrate   | Applies `infra/sql/*.sql` and records history in PostgreSQL's `migrations` table. Server startup only checks the schema.                                          |
| Server    | Owns gameplay and saved state on port **3200**, using `.env.server`.                                                                                              |
| Client    | Serves the game and assets on port **3102**, proxies requests to the server, and uses `.env.client`.                                                              |

Next: [Custom content](custom-content.md). For settings, troubleshooting and production, see [Development](development.md). For direct static hosting on Debian, follow [Deploying to server with Caddy](../README.md#deploying-to-server-with-caddy), including the home-directory permissions needed to avoid 403 responses.

Combat mechanics: [modern formulas and content mapping](combat-formulas.md).
