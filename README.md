# SmarterGamers DLSS 5 Swapper

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](https://microsoft.com/windows)
[![Maintained by SmarterGamers](https://img.shields.io/badge/Maintained%20by-SmarterGamers.com-f59e0b.svg)](https://SmarterGamers.com)

**SmarterGamers DLSS 5 Swapper** is an open-source utility designed to make modern neural rendering, upscaling injection, and graphics translation straightforward and safe for PC gamers.

This project revives and maintains the original DLSS 5 Swapper as a completely transparent, community-driven open-source tool hosted by [SmarterGamers.com](https://SmarterGamers.com).

---

## 🚀 Key Features

* **Universal Library Detection:** Automatically scans and detects installed games across **Steam**, **Epic Games Store**, and custom local directories.
* **Neural Rendering & Upscaling Management:** Seamlessly integrates **DLSS 5 Neural Rendering (DLSS-NR)**, **OptiScaler**, and **RenoDX** injection pipelines.
* **Legacy DirectX Translation:** Powered by upstream **dgVoodoo2** to enable modern post-processing and upscaling pipelines on classic DirectX 8, 9, and DirectDraw games.
* **Safe Injection & Rollback:** Maintains an internal per-game file journal (`_DLSS5_Backup` and manifest) ensuring that any game can be restored to its original, untouched state with a single click.
* **In-Game Overlay Controls:** Optional real-time overlay panel to tune neural rendering weights and motion vector providers in-game.

---

## 🛡️ Security, Transparency & Integrity

Following community discussions regarding past releases, this repository provides complete transparency into how the app works:

1. **Fully Open Source:** Every single line of code (Electron main process, renderer UI, and injector handlers) is auditable directly in this repository.
2. **Cryptographic Checksums:** Third-party runtime components (such as official dgVoodoo2 and LumeniteFX shaders) are fetched directly from their official upstream author repositories and verified against **hardcoded SHA-256 digests**. If a download differs by even one bit, it is immediately discarded.
3. **No Hidden Telemetry or Spyware:** The application contains zero credential harvesting, token grabbing, or hidden tracking scripts. All network interactions are limited to official GitHub release checks, game art retrieval, and user-initiated compatibility ratings.
4. **Heuristic Antivirus Flags:** Like many DLL injection, ReShade, and game modding tools, Windows Defender or other AVs may flag injection hooks under generic heuristic categories (e.g. `!rfn`). These are heuristic flags triggered by DLL hooking techniques, not malicious code.

---

## ☕ Support SmarterGamers

Maintaining and improving open-source gaming utilities requires ongoing testing and infrastructure:

* **Official Website:** [SmarterGamers.com](https://SmarterGamers.com)
* **Donate / Support:** [smartergamers.com/support](https://smartergamers.com/support/)
* **Buy Me a Coffee:** [buymeacoffee.com/SmarterGamers](https://buymeacoffee.com/SmarterGamers)

Your contributions help us keep tools open, safe, and available for everyone.

---

## ⚡ Quick Install (Recommended for Gamers)

If you just want to use the app on your PC without setting up Node.js or compiling code:

### Method 1: 1-Line Quick Install (PowerShell)
Press <kbd>Win</kbd> + <kbd>X</kbd>, select **Terminal** (or **PowerShell**), paste this command, and press <kbd>Enter</kbd>:
```powershell
irm https://raw.githubusercontent.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/main/install.ps1 | iex
```
*This automatically downloads the latest verified GitHub release, verifies checksums, and installs the desktop app with one click.*

### Method 2: Windows Package Manager (`winget`)
Install using the included `winget` manifest:
```cmd
winget install -m https://raw.githubusercontent.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/main/manifests/SmarterGamers.DLSS5Swapper.yaml
```
*(Note: If prompted by Windows, enable local manifest support once with `winget settings --enable LocalManifestFiles`).*

### Method 3: Direct Download (.exe)
Download and run the installer directly from our official GitHub release:
* 📥 **[Download Windows Installer (`.exe`)](https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/releases/latest)**
* 📦 **[Download Portable Edition (`.exe`)](https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/releases/latest)**

---

## 🛠️ Building & Running from Source

### Prerequisites
* Windows 10 / 11 (64-bit)
* [Node.js](https://nodejs.org/) v18 or newer
* Git

### Step-by-Step Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper.git
   cd SmarterGamers-DLSS5-Swapper
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run in development mode:**
   ```bash
   npm start
   ```

4. **Build distribution binaries (installer & portable):**
   ```bash
   npm run dist
   ```
   Packaged binaries will be created inside the `dist/` directory.

---

## 📜 Upstream Attribution & Licenses

This tool coordinates and deploys several independent open-source technologies:

* **DLSS5-Feeder:** Developed by [jlrouzies-fr](https://github.com/jlrouzies-fr/DLSS5-Feeder) (MIT License).
* **OptiScaler DLSS-NR:** Developed by [Dagherbou](https://github.com/Dagherbou/OptiScaler_DLSSNR) and [wilsjo2](https://github.com/wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass) (GPL-3.0 License).
* **RenoDX:** Created by [ShortFuse](https://github.com/clshortfuse/renodx).
* **dgVoodoo2:** Graphics translation wrapper created by [Dege](https://github.com/dege-diosg/dgVoodoo2).
* **LumeniteFX:** Motion vector shaders created by [umar-afzaal](https://github.com/umar-afzaal/LumeniteFX).
* **Original App Architecture:** Created by Rakan Alkhaldi (rakanki911), released under the MIT License.

For detailed third-party licenses and notices, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## ⚖️ License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more details.
