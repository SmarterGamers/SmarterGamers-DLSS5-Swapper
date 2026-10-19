# Contributing to SmarterGamers DLSS 5 Swapper

Thank you for your interest in contributing to **SmarterGamers DLSS 5 Swapper**! We welcome bug reports, feature suggestions, UI polish, and pull requests from the community.

---

## 🛠️ Development Setup

1. **Prerequisites:**
   * Node.js v18 or newer
   * Git for Windows

2. **Clone and Install:**
   ```bash
   git clone https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper.git
   cd SmarterGamers-DLSS5-Swapper
   npm install
   ```

3. **Running the Application:**
   ```bash
   npm start
   ```

---

## 🔒 Security & Code Standards

To keep the application safe, transparent, and trusted:

* **Cryptographic Verification Required:** Any external download routine must specify a pinned SHA-256 hash that is verified before files are unpacked or moved into place.
* **HTTPS Only:** All external endpoints must use secure HTTPS.
* **No Telemetry / Hidden Trackers:** We do not collect user data, passwords, or personal telemetry. Maintain user privacy at all times.
* **Preserve Rollback Safety:** Any changes to `apply.js` or installation paths must preserve the rollback journal (`_DLSS5_Backup`) so games can be cleanly restored.

---

## 🤝 Submitting Changes

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to your branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request on GitHub.

Thank you for helping us keep open-source gaming tools alive!
