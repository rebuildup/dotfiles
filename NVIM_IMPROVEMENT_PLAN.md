# Neovim Improvement Plan

## Current State Analysis

### Existing Configuration
- **Plugin Manager**: lazy.nvim
- **Plugins**: blink.cmp, gitsigns.nvim, telescope.nvim, conform.nvim, mason.nvim, nvim-lspconfig, friendly-snippets
- **LSP**: rust_analyzer, lua_ls (using modern `vim.lsp.enable()` API)
- **Completion**: blink.cmp with custom keymaps
- **Snippets**: friendly-snippets + local `rust.json` (VS Code format)
- **Shared Config**: `~/vimfiles/shared/base.vim` (Vim/Neovim common)
- **Keymaps**: Large portion in base.vim (window, tab, basic editing)
- **Snippet Sync**: One-way script `strip_jsonc.py` (VS Code → Neovim)

### Missing / Needs Improvement
1. **Bidirectional snippet sync** - Single source of truth, editable from both editors
2. **File explorer** - oil.nvim / mini.files
3. **Treesitter** - Installed but not configured
4. **which-key.nvim** - Keymap discovery
5. **Auto-pairs** - mini.pairs / nvim-autopairs
6. **Statusline** - snacks.nvim / mini.statusline / lualine
7. **Terminal integration** - toggleterm.nvim / snacks.terminal
8. **Breadcrumbs/symbol outline** - snacks.win / aerial.nvim
9. **LSP enhancements** - signature help, better code actions, inlay hints toggle
10. **VS Code-like keymaps** - Consistent leader-based mappings

## Implementation Priority

### Phase 1: Core Infrastructure (High Impact)
1. Treesitter setup with highlights, textobjects
2. File explorer (oil.nvim - lightweight, buffer-based)
3. which-key.nvim for keymap discovery
4. Auto-pairs (mini.pairs - lightweight)
5. Statusline (snacks.nvim - multi-purpose, or mini.statusline)

### Phase 2: Snippet System (Critical Requirement)
1. Design single-source snippet directory structure
2. Implement LuaSnip with VS Code snippet loading
3. Create bidirectional sync mechanism (file watcher + manual sync command)
4. Migrate existing snippets

### Phase 3: LSP & Completion Polish
1. Enhance blink.cmp config (signature help, better menu)
2. LSP keymaps (definition, references, rename, code action)
3. Diagnostic UI improvements
4. Inlay hints toggle

### Phase 4: UI & Workflow
1. Terminal integration (snacks.terminal)
2. Breadcrumbs / symbol outline
3. Better Telescope config (file icons, preview)
4. Git enhancements (diffview.nvim)

### Phase 5: Keymap Unification
1. Leader-based consistent mappings
2. which-key groups
3. Documentation

## Snippet Architecture Decision

### Single Source of Truth: `~/.dotfiles/home/snippets/`
```
snippets/
├── package.json          # For LuaSnip + VS Code compatibility
├── rust.json             # Rust snippets
├── typescript.json       # TS/TSX snippets
├── javascript.json       # JS snippets
├── html.json
├── css.json
├── json.json
├── cpp.json
└── ...                   # Other languages
```

### Neovim Side: LuaSnip
- Loads VS Code format snippets directly via `require("luasnip.loaders.from_vscode").lazy_load()`
- Supports placeholders, choices, variables, transforms
- Integrates with blink.cmp via `blink.cmp.sources.snippets`

### VS Code Side: Symlink
- Symlink `~/.dotfiles/home/snippets/*.json` → `~/Library/Application Support/Code/User/snippets/`
- Or use VS Code `snippets` setting to add extra snippet paths

### Sync Strategy
- **Source of truth**: dotfiles `snippets/` directory
- **VS Code → Neovim**: Edit in VS Code, saves to dotfiles (via symlink), Neovim hot-reloads
- **Neovim → VS Code**: Edit in Neovim (LuaSnip), write to dotfiles, VS Code auto-reloads
- **Conflict resolution**: Last write wins (both editors watch for file changes)

## Plugin Selection

| Need | Choice | Reason |
|------|--------|--------|
| File Explorer | oil.nvim | Buffer-based, lightweight, edits dirs like files |
| Keymap Guide | which-key.nvim | Standard, deferred loading |
| Auto-pairs | mini.pairs | Tiny, part of mini.nvim ecosystem |
| Statusline | mini.statusline | Lightweight, configurable |
| Terminal | snacks.terminal | Part of snacks, integrates with picker |
| Breadcrumbs | snacks.win + custom | Lightweight, uses floating windows |
| Treesitter | nvim-treesitter | Standard, lazy-loaded |
| Snippets | LuaSnip | Best VS Code format support |
| Completion | blink.cmp | Already installed, fast |
| Git Diff | diffview.nvim | Better than gitsigns for diffs |
| Picker | telescope.nvim | Already installed, enhance config |

## Performance Targets
- Startup time: < 30ms (currently ~10-20ms)
- Lazy-load everything possible
- No synchronous file I/O on startup
- Defer non-critical plugins

## Cross-Platform Considerations
- Paths: Use `vim.fn.stdpath()` and `vim.env`
- Symlinks: Windows needs Developer Mode or admin; fallback to copy documented
- Shell: Use `vim.fn.has('win32')` checks
- Clipboard: Windows uses `unnamed` (not `unnamedplus`)

## Verification Checklist
- [x] Neovim starts without errors
- [x] Snippets expand + Tab navigation works
- [x] VS Code ↔ Neovim snippet sync works
- [x] LSP completion, goto def, diagnostics work
- [x] File search, grep, buffer switch work
- [x] Git signs + diff view work
- [x] Keymaps consistent, no conflicts
- [x] Startup time < 30ms
- [x] Large files performant

## Completed Phases
- ✅ Phase 1: Core Infrastructure (Treesitter, oil.nvim, which-key, mini.nvim, snacks.nvim)
- ✅ Phase 2: Snippet System (LuaSnip, bidirectional sync, 7 languages)
- ✅ Phase 3: LSP & Completion Polish (blink.cmp enhanced, LSP keymaps, inlay hints)
- ✅ Phase 4: UI & Workflow (Terminal, Telescope enhanced, diffview)
- ✅ Phase 5: Keymap Unification (Leader-based, which-key groups)