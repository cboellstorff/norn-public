# ROADMAP: the tide-app program (living catalogue)
**2026-03-02 R3 (release 7 out):** main = abc1234f0; the dated notes stay prose, never items.

STANDING RULES that shape every item:
- **Offline first.** Every feature works without a network.
- **One map layer per source.**

STATUS LADDER - every row carries exactly one: REQUESTED | SPEC'D | BUILDING | BUILT NOT WIRED | MERGED DEFAULT OFF | SHIPPED | DROPPED.

## 1. Now (release 7 LIVE; refreshed 2026-03-02)
LIVE: release 7 (main abc1234f0).
| Item | Status | Evidence / notes |
|---|---|---|
| **TIDE CACHE** (owner DIR-3): tables cached per station | **SHIPPED** (release 7, abc1234f0) | feat/tide-cache merged; RUN-4 |
| STORM ALERTS - push when a front nears | BUILDING (feat/storm-alerts, DEC-12 ruled the push service) | spec-STORM.md |

## 1b. Done but not installed (inventory 2026-03-01)
### Every branch with commits ahead of main
| Branch | Tip | Ahead / behind | Lane state |
|---|---|---|---|
| feat/offline-sync | 9f8e7d6c5 | 4 / 0 | DONE |

## 2. Maps and look
| Item | Status | Spec / notes |
|---|---|---|
| Station map: one layer per source | SPEC'D (ruled DEC-12) | docs/map.md; spec-STORM.md |
| OFFLINE SYNC = background sync of saved stations | built not wired: BUILT NOT WIRED (feat/offline-sync, Q-2 open) | DLV-1 |
| Dark map theme | REQUESTED (owner 2026-02-20) | - |
| Old importer | DROPPED (DEC-12: replaced by the new one) | - |
| | SHIPPED | a row with no item text |

## 3. Platform
| Item | Status | Notes |
|---|---|---|
| Watch app | MERGED DEFAULT OFF (flag watch.enabled; DIR-9) | branch gone |

## 8. Order (as in force 2026-03-02)
1. **Release 8** (DIR-3): storm alerts, then offline sync.

## 9. Owner rulings log (verbatim history)
- 2026-02-20: dark map theme requested.

## Superseded (kept verbatim)
### Old sec. 1
| Item | Status | Evidence / notes |
|---|---|---|
| TIDE CACHE | BUILDING (feat/tide-cache) | old row |
