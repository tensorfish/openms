---
search: false
---

# Inputs and provenance

For a fresh local setup, follow [Quick Start](index.md). Select your original WZ directory with `--assets`; the absolute paths below record the supplied evidence and are not required installation locations.

Download the original asset ZIP from [Maplestory-Assets.zip](https://bucket.openms.dev/Maplestory-Assets.zip). It contains a top-level `Maplestory-Client/` directory with the WZ archives. Follow [Quick Start](index.md) or [Windows setup](windows-setup.md) to extract only its WZ data, then pass the data directory through `--assets`.

During local setup on 2026-09-18, Microsoft Defender flagged `MapleStory.exe` as `Trojan:MSIL/Cryptor!rfn` and `Maplestory_UNPACKED.exe` as `PUA:Win32/GameHack` inside the downloaded ZIP. Neither executable was extracted or run. The 17 retained WZ files matched [the input manifest](input-manifest.json) and scanned clean. This records that scan result, not a guarantee about future downloads or file safety. EXE and DLL entries in the manifest document provenance; they are not runtime dependencies. Keep antivirus protection enabled, extract only WZ files, and delete the ZIP after retaining the required data.

Original input directory: `/Users/k/Development/tensorfish/Maplestory-Client`.

Present: `Maplestory_UNPACKED.exe` (actual spelling), protected `MapleStory.exe`, original DLLs including `NameSpace.dll`, `ResMan.dll`, `Canvas.dll`, `ZLZ.dll`, `Gr2D_DX8.dll`, and WZ archives including `Map.wz`, `Character.wz`, `Base.wz`.

No original C/C++ source or original-client screenshots/capture sequences were found in the supplied original input tree. Ghidra output is decompiler evidence, **not original source**. Native original-client execution on this macOS ARM64 host has not been established.

The supplied community remake and sibling reconstructions are excluded as implementation sources. No code or format definitions are copied from them.

Ghidra installation: `/Users/k/Downloads/ghidra_12.0.4_PUBLIC`. Analysis uses separate temporary headless projects and preserves selected address-bearing reports here. Windows executables are analyzed, not executed.

## Available server reference

The additional supplied tree `/Users/k/Development/tensorfish/MapleStory-Server` identifies itself in `README.md` as **Cosmic**, a Global MapleStory v83 server emulator descended from OdinMS/HeavenMS. It contains Java server logic, JavaScript scripts and WZ exports. The user explicitly authorized consulting this server code for the current gameplay corrections.

This is **server-reference evidence, not original Nexon server source**. Cite exact consumers and distinguish emulator behavior from original executable/WZ observations; corroborate timing and presentation against the original client where available. Sibling third-party **client** reconstructions remain excluded. The application's [Bun server](development.md#server) uses explicitly versioned development/reference rules; its authority over online state does not make those policies original Nexon behavior.

The build no longer requires that checkout. The 37 reference SQL scripts live in [`infra/sql/`](../infra/sql/README.md), and all 1,915 gameplay scripts live in [`infra/gameplay-definitions/`](../infra/gameplay-definitions/README.md), with upstream licenses and byte/hash manifests. The six settings consumed by the converter are recorded in `infra/gameplay-definitions/policy.json`; Java files, Java hashes and the full server `config.yaml` are not build inputs. The converter reads these repository-owned snapshots by default. These MySQL reference scripts are parsed into game data; OpenMS's numbered PostgreSQL scripts live directly in `infra/sql/` and are applied by the explicit `migrate` CLI; the imported reference files remain under `tables/` and `data/`. Tool source paths use flags (`--assets`, `--gameplay-definitions-root`, `--sql-root`) under the [CLI configuration rule](coding-style.md#cli-configuration).

Direct archive observations: `Base.wz`, `Map.wz`, and `Character.wz` begin with `PKG1`; offset 12 contains little-endian `60`; offset 60 contains bytes `ac 00`. `List.wz` has a different header and is not presumed to use the same structure. Interpretations require the accompanying Ghidra evidence and successful archive probes.
