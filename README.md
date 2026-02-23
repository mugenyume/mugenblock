# 🌊 MugenBlock Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-0.1.0-cyan.svg)](https://github.com/mugenyume/mugenblock/releases)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20|%20Edge%20|%20Brave-brightgreen.svg)]()

**MugenBlock** is a next-generation browser extension dedicated to infinite privacy and performance. Built on a high-speed filtering engine, it provides a premium, ad-free browsing experience while ensuring 100% of your data remains on your local device.

---

## ✨ Features

- **🛡️ Multi-Level Protection**: Choose between *Lite*, *Standard*, and *Advanced* modes to balance performance and aggressive blocking.
- **🚀 Ultra-Fast Engine**: Optimized ruleset indexing using Chrome's Declarative Net Request (DNR) API for zero-latency filtering.
- **💎 Premium UI/UX**: State-of-the-art dark theme dashboard with glassmorphism aesthetics and real-time protection stats.
- **🔒 Zero-Telemetry Privacy**: No data collection, no cloud tracking, and no leakage. Your browsing history is yours alone.
- **⚡ Script & Cosmetic Fixes**: Advanced heuristic engine to remove ad-placeholders and fix site breakage caused by traditional blockers.
- **📦 Backup & Restore**: Easily migrate your custom site overrides and settings between devices.

---

## 🛠 Technology Stack

- **Frontend**: [React](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/)
- **Styling**: Vanilla CSS (Custom Variable-based Design System)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Core API**: Chrome Extension Manifest V3 (DNR, Storage, Background Service Workers)

---

## 📥 Quick Install

### Regular Users (Recommended)
1. Go to the [**Releases**](https://github.com/mugenyume/mugenblock/releases) page.
2. Download the latest `mugenblock.zip`.
3. Unzip the file on your computer.
4. Open your browser and go to `chrome://extensions/`.
5. Enable **Developer Mode** (top right).
6. Click **Load unpacked** and select the folder you just unzipped.

### Developers
If you want to build the project from source:

```bash
# Clone the repository
git clone https://github.com/mugenyume/mugenblock.git
cd mugenblock

# Install project-wide dependencies
npm install

# Build the production extension
npm run build
```
The compiled extension will be ready in the `/extension/dist/` directory.

---

## 👩‍💻 Developer

Developed with ❤️ by [**mugenyume**](https://github.com/mugenyume).

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
