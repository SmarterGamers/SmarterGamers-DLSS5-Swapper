# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.3.x   | :white_check_mark: |
| < 2.3.0 | :x:                |

---

## Reporting a Vulnerability

The SmarterGamers team takes software security and community trust seriously.

If you believe you have discovered a vulnerability, security flaw, or supply-chain issue in SmarterGamers DLSS 5 Swapper:

1. **Do not disclose publicly.**
2. Email your findings directly to **[support@smartergamers.com](mailto:support@smartergamers.com)** or open a private GitHub security advisory.
3. Please include:
   * Description of the issue
   * Steps or script to reproduce
   * Potential impact

We will investigate and publish patches as quickly as possible.

---

## Cryptographic Validation Guarantee

All runtime components fetched dynamically by this tool (such as dgVoodoo2 and LumeniteFX shaders) are locked to hardcoded cryptographic SHA-256 digests. If an upstream release or mirror is altered by even one bit, the download is immediately rejected by `fetchVerified` and deleted.
