# GatheringScans — E2E Testing Architecture & Verification Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Architectural Principles

This document establishes the end-to-end testing architecture and verification framework for civil surveying, construction QA, earthwork takeoff, and Scan-to-BIM capabilities in GatheringScans (`scans.gatheren.cloud`).

### Key Design Pillars:
1. **Zero Data Destruction**: The test suite operates with absolute read-only safety towards production scan data (`C:\GatheringScans\*`), user comments, photo attachments, and categorization caches. All dynamic/transient tests must execute in isolated temporary SQLite databases (`tempfile.mkstemp`) or mock memory contexts.
2. **Strict 5,000-Line Modular File Ceiling**: Every test file and application source file (`.py`, `.js`, `.css`, `.html`) must strictly remain `< 5,000 lines`. Monolithic test or source bloat is caught by automated structural assertions.
3. **Dual-Environment Parity**: Calculations and API routes must execute consistently on both Windows local host (`127.0.0.1:8095`) and the production Linux Hostinger VPS (`scans.gatheren.cloud`).
4. **4-Tier Verification Hierarchy**:
   - **Tier 1**: Feature Coverage (Analytical math, unit algorithms, REST APIs)
   - **Tier 2**: Boundaries & Robustness (Degenerate geometries, numerical singularities, extreme scale)
   - **Tier 3**: Cross-Feature Integration (Multi-Epoch Compare, 3D Studio, Bookmarks, UI container switching)
   - **Tier 4**: Real-World Workload (Verification against the 4 live production datasets)
