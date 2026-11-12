# Changelog

## [0.4.0] - 2026-11-13

### Added

- Independent building and prop transforms, local building geometry and facade UVs.
- PBR material library with previews, per-part wall/roof/trim assignments and prop overrides.
- Architectural details, outdoor lighting, quality presets and optional shadows.
- Road drafting previews, height-aware connections, control-point editing and measurements.
- Compact VSPB 2 storage with v1 import, resource validation and lossless terrain overrides.
- Game-oriented GLB metadata with road connectivity and geometry ownership.

### Changed

- Replaced Electron with Tauri and a bundled portable Node MCP bridge.
- Reorganized the workspace, inspector, desktop sources, tests and diagnostic tools.
- Reduced rendering work through spatial batches, instancing and adaptive terrain LOD.
- Unified editing validation and transformations across the UI and MCP.

### Fixed

- Atomic undo/redo and batch rollback, including restored selection.
- Save/open races, canceled file dialogs and native save-destination handling.
- Material and geometry resource leaks, transparent-object sorting and tunnel shadow artifacts.
- World-anchored building textures, transformed picking and level-crossing road connections.
- Removed train rendering, simulation and train controls from the editor.

### Compatibility

- Existing VSPB v1 cities open automatically; newly saved files require a VSPB 2 reader.
- macOS packages require macOS 13.5 or newer; Linux packages use WebKitGTK 4.1.
- macOS packages use ad-hoc signatures; Windows installers are unsigned.
- Updates use complete installers. Engine-specific collision/navigation generation is not included.
