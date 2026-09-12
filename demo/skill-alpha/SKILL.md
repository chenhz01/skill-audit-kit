# Skill: router-core

name: router-core
description: Routes incoming intents to the right skill in a skill library.

## Use when
A task arrives and you must decide which skill handles it.

## References
Delegates conflict resolution to conflict-detector. Falls back to base-kit for unmatched intents. Availability is reported by library-stats.
