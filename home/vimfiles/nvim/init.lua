local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"

if not vim.loop.fs_stat(lazypath) then
	vim.fn.system({
		"git",
		"clone",
		"--filter=blob:none",
		"https://github.com/folke/lazy.nvim.git",
		"--branch=stable",
		lazypath,
	})
end

vim.opt.rtp:prepend(lazypath)

-- 起動時パフォーマンス: 未使用providerを無効化
vim.g.loaded_perl_provider = 0
vim.g.loaded_ruby_provider = 0
vim.g.loaded_node_provider = 0
vim.g.loaded_python3_provider = 0

vim.opt.shadafile = "NONE"
vim.opt.updatetime = 300
vim.opt.signcolumn = "yes"
vim.opt.lazyredraw = false

-- リーダーキー
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

require("lazy").setup({
	spec = {
		-- =============================================================
		-- Core: Treesitter (構文解析・ハイライト・テキストオブジェクト)
		-- =============================================================
		{
			"nvim-treesitter/nvim-treesitter",
			build = ":TSUpdate",
			event = { "BufReadPost", "BufNewFile" },
			cmd = { "TSUpdateSync", "TSInstall", "TSUninstall" },
			opts = {
				ensure_installed = {
					"bash",
					"c",
					"cpp",
					"css",
					"html",
					"javascript",
					"json",
					"jsonc",
					"lua",
					"markdown",
					"markdown_inline",
					"python",
					"query",
					"regex",
					"rust",
					"toml",
					"tsx",
					"typescript",
					"vim",
					"vimdoc",
					"yaml",
				},
				auto_install = true,
				highlight = { enable = true, additional_vim_regex_highlighting = false },
				indent = { enable = true },
				incremental_selection = {
					enable = true,
					keymaps = {
						init_selection = "<C-space>",
						node_incremental = "<C-space>",
						scope_incremental = false,
						node_decremental = "<bs>",
					},
				},
				textobjects = {
					select = {
						enable = true,
						lookahead = true,
						keymaps = {
							["af"] = "@function.outer",
							["if"] = "@function.inner",
							["ac"] = "@class.outer",
							["ic"] = "@class.inner",
							["aa"] = "@parameter.outer",
							["ia"] = "@parameter.inner",
						},
					},
					move = {
						enable = true,
						set_jumps = true,
						goto_next_start = { ["]f"] = "@function.outer", ["]c"] = "@class.outer" },
						goto_previous_start = { ["[f"] = "@function.outer", ["[c"] = "@class.outer" },
					},
				},
			},
			config = function(_, opts)
				require("nvim-treesitter.config").setup(opts)
			end,
		},
		{
			"nvim-treesitter/nvim-treesitter-textobjects",
			event = { "BufReadPost", "BufNewFile" },
		},

		-- =============================================================
		-- File Explorer: oil.nvim (バッファベース、軽量)
		-- =============================================================
		{
			"stevearc/oil.nvim",
			cmd = "Oil",
			keys = {
				{ "<leader>e", "<cmd>Oil<cr>", desc = "File explorer" },
				{ "<leader>E", "<cmd>Oil .<cr>", desc = "File explorer (cwd)" },
			},
			opts = {
				default_file_explorer = true,
				columns = { "icon", "permissions", "size", "mtime" },
				keymaps = {
					["g?"] = "actions.show_help",
					["<CR>"] = "actions.select",
					["<C-v>"] = { "actions.select", opts = { vertical = true }, desc = "Open in vertical split" },
					["<C-s>"] = { "actions.select", opts = { horizontal = true }, desc = "Open in horizontal split" },
					["<C-t>"] = { "actions.select", opts = { tab = true }, desc = "Open in new tab" },
					["<C-p>"] = "actions.preview",
					["<C-c>"] = "actions.close",
					["<C-r>"] = "actions.refresh",
					["-"] = "actions.parent",
					["_"] = "actions.open_cwd",
					["`"] = "actions.cd",
					["~"] = { "actions.cd", opts = { scope = "tab" }, desc = "cd to home" },
					["gs"] = "actions.change_sort",
					["gx"] = "actions.open_external",
					["g."] = "actions.toggle_hidden",
					["g\\"] = "actions.toggle_trash",
				},
				view_options = {
					show_hidden = true,
					is_always_hidden = function(name, _)
						return name == ".." or name == ".git"
					end,
				},
				float = {
					padding = 2,
					max_width = 0.8,
					max_height = 0.8,
					border = "rounded",
				},
			},
		},

		-- =============================================================
		-- Completion: blink.cmp (高速、LSP統合)
		-- =============================================================
		{
			"saghen/blink.cmp",
			version = "1.*",
			dependencies = {
				"L3MON4D3/LuaSnip",
				"rafamadriz/friendly-snippets",
			},
			event = { "BufReadPost", "BufNewFile" },
			opts = {
				keymap = {
					preset = "none",
					["<C-n>"] = { "select_next", "fallback" },
					["<C-p>"] = { "select_prev", "fallback" },
					["<C-Space>"] = { "show", "fallback" },
					["<C-e>"] = { "hide", "fallback" },
					["<C-d>"] = { "scroll_documentation_down", "fallback" },
					["<C-u>"] = { "scroll_documentation_up", "fallback" },
					["<C-y>"] = { "select_and_accept" },
					-- Tab: snippet次 → 候補確定(選択済みをaccept、未選択なら先頭をaccept) → 通常Tab
					["<Tab>"] = { "snippet_forward", "select_and_accept", "fallback" },
					-- Shift+Tab: snippet前 → 候補を前へ → 通常Shift+Tab
					["<S-Tab>"] = { "snippet_backward", "select_prev", "fallback" },
					["<CR>"] = { "accept", "fallback" },
				},
				cmdline = {
					enabled = true,
					keymap = {
						preset = "inherit",
						["<Tab>"] = { "show_and_insert", "select_next" },
						["<S-Tab>"] = { "show_and_insert", "select_prev" },
					},
				},
				completion = {
					documentation = {
						auto_show = true,
						auto_show_delay_ms = 200,
						window = { border = "rounded" },
					},
					menu = {
						border = "rounded",
						draw = {
							columns = {
								{ "kind_icon", "label", "label_description", gap = 1 },
								{ "source_name" },
							},
						},
					},
					ghost_text = { enabled = true },
				},
				signature = {
					enabled = true,
					window = { border = "rounded" },
				},
				sources = {
					default = { "lsp", "path", "snippets", "buffer" },
					providers = {
						snippets = {
							name = "snippets",
							module = "blink.cmp.sources.snippets",
							score_offset = 4,
						},
					},
				},
				snippets = { preset = "luasnip" },
			},
			config = function(_, opts)
				require("blink.cmp").setup(opts)
			end,
		},

		-- =============================================================
		-- Snippets: LuaSnip (VS Code形式対応、高機能)
		-- =============================================================
		{
			"L3MON4D3/LuaSnip",
			version = "v2.*",
			build = "make install_jsregexp",
			event = { "BufReadPost", "BufNewFile" },
			dependencies = {
				"rafamadriz/friendly-snippets",
			},
			opts = {
				history = true,
				delete_check_events = "TextChanged",
				enable_autosnippets = true,
			},
			config = function(_, opts)
				require("luasnip").setup(opts)
				-- ドットファイル管理のスニペットディレクトリを読み込み
				local snippet_dir = vim.fn.expand("~/.dotfiles/home/snippets")
				if vim.fn.isdirectory(snippet_dir) == 1 then
					require("luasnip.loaders.from_vscode").load({ paths = { snippet_dir } })
				end
				-- friendly-snippetsも読み込み (package.jsonがルートにあるため明示的なパス指定が必要)
				local friendly_dir = vim.fn.expand("~/.local/share/nvim/lazy/friendly-snippets")
				if vim.fn.isdirectory(friendly_dir) == 1 then
					require("luasnip.loaders.from_vscode").load({ paths = { friendly_dir } })
				end
			end,
		},

		-- =============================================================
		-- Git: gitsigns.nvim (サイン表示) + diffview.nvim (差分表示)
		-- =============================================================
		{
			"lewis6991/gitsigns.nvim",
			event = { "BufReadPost", "BufNewFile" },
			opts = {
				signs = {
					add = { text = "▎" },
					change = { text = "▎" },
					delete = { text = "" },
					topdelete = { text = "" },
					changedelete = { text = "▎" },
					untracked = { text = "▎" },
				},
				signcolumn = true,
				numhl = false,
				linehl = false,
				word_diff = false,
				watch_gitdir = { interval = 1000, follow_files = true },
				attach_to_untracked = true,
				current_line_blame = false,
				current_line_blame_opts = { virt_text = true, virt_text_pos = "eol", delay = 500 },
				preview_config = { border = "rounded" },
				on_attach = function(bufnr)
					local gs = package.loaded.gitsigns
					local function map(mode, l, r, desc)
						vim.keymap.set(mode, l, r, { buffer = bufnr, desc = desc })
					end
					map("n", "]h", gs.next_hunk, "Next hunk")
					map("n", "[h", gs.prev_hunk, "Prev hunk")
					map("n", "<leader>hs", gs.stage_hunk, "Stage hunk")
					map("n", "<leader>hr", gs.reset_hunk, "Reset hunk")
					map("n", "<leader>hS", gs.stage_buffer, "Stage buffer")
					map("n", "<leader>hu", gs.undo_stage_hunk, "Undo stage hunk")
					map("n", "<leader>hp", gs.preview_hunk, "Preview hunk")
					map("n", "<leader>hb", function() gs.blame_line({ full = true }) end, "Blame line")
					map("n", "<leader>hd", gs.diffthis, "Diff this")
					map("n", "<leader>hD", function() gs.diffthis("~") end, "Diff this ~")
					map("n", "<leader>tb", gs.toggle_current_line_blame, "Toggle blame line")
					map("n", "<leader>td", gs.toggle_deleted, "Toggle deleted")
				end,
			},
		},
		{
			"sindrets/diffview.nvim",
			cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewFileHistory" },
			keys = {
				{ "<leader>gd", "<cmd>DiffviewOpen<cr>", desc = "Git diff view" },
				{ "<leader>gD", "<cmd>DiffviewClose<cr>", desc = "Close diff view" },
				{ "<leader>gh", "<cmd>DiffviewFileHistory<cr>", desc = "Git file history" },
			},
			opts = {
				enhanced_diff_hl = true,
				view = {
					default = { winbar_info = true },
					merge_tool = { layout = "diff3_mixed" },
				},
			},
		},

		-- =============================================================
		-- Search: telescope.nvim (ファイル・全文検索)
		-- =============================================================
		{
			"nvim-telescope/telescope.nvim",
			cmd = "Telescope",
			keys = {
				{ "<leader>ff", "<cmd>Telescope find_files<cr>", desc = "Find files" },
				{ "<leader>fg", "<cmd>Telescope live_grep<cr>", desc = "Live grep" },
				{ "<leader>fb", "<cmd>Telescope buffers<cr>", desc = "Buffers" },
				{ "<leader>fh", "<cmd>Telescope help_tags<cr>", desc = "Help tags" },
				{ "<leader>fs", "<cmd>Telescope lsp_document_symbols<cr>", desc = "Document symbols" },
				{ "<leader>fS", "<cmd>Telescope lsp_workspace_symbols<cr>", desc = "Workspace symbols" },
				{ "<leader>fr", "<cmd>Telescope lsp_references<cr>", desc = "References" },
				{ "<leader>fd", "<cmd>Telescope diagnostics<cr>", desc = "Diagnostics" },
				{ "<leader>fk", "<cmd>Telescope keymaps<cr>", desc = "Keymaps" },
				{ "<leader>fc", "<cmd>Telescope commands<cr>", desc = "Commands" },
				{ "<leader>fm", "<cmd>Telescope marks<cr>", desc = "Marks" },
				{ "<leader>fo", "<cmd>Telescope oldfiles<cr>", desc = "Recent files" },
			},
			dependencies = {
				"nvim-lua/plenary.nvim",
				{ "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
			},
			opts = {
				defaults = {
					prompt_prefix = "  ",
					selection_caret = "  ",
					border = "rounded",
					sorting_strategy = "ascending",
					layout_config = {
						horizontal = { prompt_position = "top", preview_width = 0.55 },
						vertical = { mirror = false },
						width = 0.87,
						height = 0.80,
					},
					mappings = {
						i = {
							["<C-j>"] = "move_selection_next",
							["<C-k>"] = "move_selection_previous",
							["<C-q>"] = "send_to_qflist",
							["<M-q>"] = "send_selected_to_qflist",
						},
					},
				},
				pickers = {
					find_files = { hidden = true, follow = true },
					buffers = { sort_lastused = true, ignore_current_buffer = true },
				},
			},
			config = function(_, opts)
				require("telescope").setup(opts)
				pcall(require("telescope").load_extension, "fzf")
			end,
		},

		-- =============================================================
		-- Formatter: conform.nvim (保存時フォーマット)
		-- =============================================================
		{
			"stevearc/conform.nvim",
			event = { "BufWritePre" },
			cmd = { "ConformInfo" },
			keys = {
				{ "<leader>cf", function() require("conform").format({ async = true, lsp_format = "fallback" }) end, desc = "Format buffer" },
			},
			opts = {
				format_on_save = { timeout_ms = 1000, lsp_format = "fallback" },
				formatters_by_ft = {
					rust = { "rustfmt" },
					lua = { "stylua" },
					python = { "ruff_format" },
					javascript = { "prettier" },
					typescript = { "prettier" },
					javascriptreact = { "prettier" },
					typescriptreact = { "prettier" },
					json = { "prettier" },
					jsonc = { "prettier" },
					css = { "prettier" },
					html = { "prettier" },
					markdown = { "prettier" },
					yaml = { "prettier" },
					toml = { "taplo" },
					sh = { "shfmt" },
					c = { "clang_format" },
					cpp = { "clang_format" },
				},
			},
		},

		-- =============================================================
		-- LSP: nvim-lspconfig + mason.nvim
		-- =============================================================
		{
			"mason-org/mason.nvim",
			cmd = { "Mason", "MasonInstall", "MasonUninstall", "MasonUpdate" },
			keys = { { "<leader>mi", "<cmd>Mason<cr>", desc = "Mason" } },
			opts = {},
		},
		{
			"neovim/nvim-lspconfig",
			event = { "BufReadPost", "BufNewFile" },
			dependencies = { "mason-org/mason.nvim" },
		},

		-- =============================================================
		-- UI: which-key.nvim (キーマップガイド)
		-- =============================================================
		{
			"folke/which-key.nvim",
			event = "VeryLazy",
			opts = {
				preset = "modern",
				delay = 300,
				icons = { mappings = true, rules = {} },
				spec = {
					{ "<leader>f", group = "Find/Search" },
					{ "<leader>g", group = "Git" },
					{ "<leader>h", group = "Git Hunk" },
					{ "<leader>c", group = "Code/Format" },
					{ "<leader>l", group = "LSP" },
					{ "<leader>t", group = "Toggle/Terminal" },
					{ "<leader>w", group = "Window" },
					{ "<leader>b", group = "Buffer" },
					{ "<leader>x", group = "Diagnostics" },
					{ "<leader>a", group = "Cargo/Action" },
					{ "g", group = "Goto" },
					{ "[", group = "Prev" },
					{ "]", group = "Next" },
				},
			},
		},

		-- =============================================================
		-- UI: mini.nvim (statusline, pairs, etc.)
		-- =============================================================
		{
			"echasnovski/mini.nvim",
			version = "*",
			event = { "BufReadPost", "BufNewFile" },
			config = function()
				-- mini.pairs: 自動括弧補完
				require("mini.pairs").setup({
					modes = { insert = true, command = false, terminal = false },
				})

				-- mini.statusline: ステータスライン
				require("mini.statusline").setup({
					use_icons = vim.g.have_nerd_font,
					content = {
						active = function()
							local mode, mode_hl = MiniStatusline.section_mode({ trunc_width = 120 })
							local git = MiniStatusline.section_git({ trunc_width = 40 })
							local diff = MiniStatusline.section_diff({ trunc_width = 75 })
							local diagnostics = MiniStatusline.section_diagnostics({ trunc_width = 75 })
							local filename = MiniStatusline.section_filename({ trunc_width = 140 })
							local fileinfo = MiniStatusline.section_fileinfo({ trunc_width = 120 })
							local location = MiniStatusline.section_location({ trunc_width = 75 })
							local search = MiniStatusline.section_searchcount({ trunc_width = 75 })

							return MiniStatusline.combine_groups({
								{ hl = mode_hl, strings = { mode } },
								{ hl = "MiniStatuslineDevinfo", strings = { git, diff, diagnostics } },
								"%<",
								{ hl = "MiniStatuslineFilename", strings = { filename } },
								"%=",
								{ hl = "MiniStatuslineFileinfo", strings = { fileinfo } },
								{ hl = mode_hl, strings = { location, search } },
							})
						end,
					},
				})

				-- mini.icons: アイコン
				require("mini.icons").setup()

				-- mini.ai: テキストオブジェクト拡張
				require("mini.ai").setup({
					custom_textobjects = {
						f = require("mini.ai").gen_spec.treesitter({ a = "@function.outer", i = "@function.inner" }),
						c = require("mini.ai").gen_spec.treesitter({ a = "@class.outer", i = "@class.inner" }),
					},
				})

				-- mini.surround: 囲み操作
				require("mini.surround").setup({
					mappings = {
						add = "gsa",
						delete = "gsd",
						find = "gsf",
						find_left = "gsF",
						highlight = "gsh",
						replace = "gsr",
						update_n_lines = "gsn",
					},
				})
			end,
		},

		-- =============================================================
		-- Terminal & UI: snacks.nvim (ターミナル、ピッカー、通知等)
		-- =============================================================
		{
			"folke/snacks.nvim",
			priority = 1000,
			lazy = false,
			keys = {
				{ "<leader>tt", function() Snacks.terminal.toggle() end, desc = "Toggle terminal" },
				{ "<leader>tf", function() Snacks.terminal.toggle(nil, { win = { position = "float" } }) end, desc = "Float terminal" },
				{ "<leader>tb", function() Snacks.terminal.toggle(nil, { win = { position = "bottom" } }) end, desc = "Bottom terminal" },
				{ "<leader>tr", function() Snacks.terminal.toggle("lazygit") end, desc = "Lazygit" },
				{ "<leader>tn", function() Snacks.notifier.show_history() end, desc = "Notification history" },
				{ "<leader>.", function() Snacks.scratch() end, desc = "Scratch buffer" },
				{ "<leader>S", function() Snacks.scratch.select() end, desc = "Select scratch buffer" },
			},
			opts = {
				terminal = {
					win = { style = "terminal", border = "rounded" },
				},
				notifier = { enabled = true, timeout = 3000 },
				scratch = { enabled = true },
				scroll = { enabled = true },
				words = { enabled = true },
				quickfile = { enabled = true },
			},
		},

		-- =============================================================
		-- Breadcrumbs/Outline: snacks.nvim win
		-- =============================================================
		{
			"folke/snacks.nvim",
			opts = {
				win = {
					enabled = true,
				},
			},
		},
	},
})

-- =============================================================
-- LSP Configuration (Neovim 0.11+ API)
-- =============================================================
vim.lsp.enable({ "rust_analyzer", "lua_ls", "ts_ls", "pyright", "clangd", "cssls", "html", "jsonls", "yamlls", "taplo" })

-- rust-analyzer: 型ヒント有効、リアルタイム診断有効、起動は軽量化
vim.lsp.config("rust_analyzer", {
	settings = {
		["rust-analyzer"] = {
			cargo = { allFeatures = true },
			checkOnSave = { command = "clippy" },
			diagnostics = { enable = true, experimental = { enable = true } },
			inlayHints = {
				bindingModeHints = { enable = true },
				chainingHints = { enable = true },
				closingBraceHints = { enable = true },
				closureReturnTypeHints = { enable = true },
				lifetimeElisionHints = { enable = true },
				parameterHints = { enable = true },
				typeHints = { enable = true },
			},
		},
	},
})

-- lua_ls: Neovim設定用に最適化
vim.lsp.config("lua_ls", {
	settings = {
		Lua = {
			workspace = { checkThirdParty = false },
			telemetry = { enable = false },
			hint = { enable = true },
		},
	},
})

-- TypeScript/JavaScript
vim.lsp.config("ts_ls", {
	settings = {
		typescript = { inlayHints = { includeInlayParameterNameHints = "all", includeInlayFunctionParameterTypeHints = true } },
		javascript = { inlayHints = { includeInlayParameterNameHints = "all", includeInlayFunctionParameterTypeHints = true } },
	},
})

-- Python
vim.lsp.config("pyright", {
	settings = {
		python = { analysis = { typeCheckingMode = "basic", autoImportCompletions = true } },
	},
})

-- =============================================================
-- LSP Keymaps (バッファローカル)
-- =============================================================
vim.api.nvim_create_autocmd("LspAttach", {
	group = vim.api.nvim_create_augroup("UserLspConfig", {}),
	callback = function(args)
		local bufnr = args.buf
		local client = vim.lsp.get_client_by_id(args.data.client_id)
		local function map(mode, lhs, rhs, desc)
			vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, desc = desc })
		end

		-- Navigation
		map("n", "gd", vim.lsp.buf.definition, "Goto definition")
		map("n", "gD", vim.lsp.buf.declaration, "Goto declaration")
		map("n", "gi", vim.lsp.buf.implementation, "Goto implementation")
		map("n", "gr", vim.lsp.buf.references, "References")
		map("n", "gt", vim.lsp.buf.type_definition, "Goto type definition")

		-- Documentation
		map("n", "K", vim.lsp.buf.hover, "Hover")
		map("n", "gK", vim.lsp.buf.signature_help, "Signature help")
		map("i", "<C-k>", vim.lsp.buf.signature_help, "Signature help")

		-- Code actions
		map({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, "Code action")
		map("n", "<leader>cr", vim.lsp.buf.rename, "Rename")

		-- Diagnostics
		map("n", "<leader>cd", vim.diagnostic.open_float, "Line diagnostics")
		map("n", "[d", function() vim.diagnostic.jump({ count = -1, float = true }) end, "Prev diagnostic")
		map("n", "]d", function() vim.diagnostic.jump({ count = 1, float = true }) end, "Next diagnostic")

		-- Inlay hints toggle
		if client and client.server_capabilities.inlayHintProvider then
			map("n", "<leader>ih", function()
				vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({ bufnr = bufnr }), { bufnr = bufnr })
			end, "Toggle inlay hints")
		end

		-- Document highlight
		if client and client.server_capabilities.documentHighlightProvider then
			local group = vim.api.nvim_create_augroup("LspDocumentHighlight", { clear = false })
			vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
				group = group,
				buffer = bufnr,
				callback = vim.lsp.buf.document_highlight,
			})
			vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
				group = group,
				buffer = bufnr,
				callback = vim.lsp.buf.clear_references,
			})
		end
	end,
})

-- =============================================================
-- Diagnostic Configuration
-- =============================================================
vim.diagnostic.config({
	virtual_text = { prefix = "●", spacing = 4, source = "if_many" },
	signs = {
		text = {
			[vim.diagnostic.severity.ERROR] = "✘",
			[vim.diagnostic.severity.WARN] = "▲",
			[vim.diagnostic.severity.INFO] = "ⓘ",
			[vim.diagnostic.severity.HINT] = "✶",
		},
	},
	underline = true,
	update_in_insert = false,
	severity_sort = true,
	float = { border = "rounded", source = "if_many" },
})

-- =============================================================
-- Completion Keymaps
-- =============================================================
-- Tab / Shift-Tab / Enter の挿入モード確定系は blink.cmp の keymap 設定に集約する。
-- blink.cmp は InsertEnter でバッファローカルに設定するため、ここで
-- グローバルな expr マップを重ねると shadow され、挙動が分かりにくくなる。
--   Tab       snippet次 → 候補確定(accept) → 通常Tab
--   Shift+Tab snippet前 → 候補を前へ → 通常Shift+Tab
--   Enter     候補確定 → 通常の改行
--   C-n/p     候補を次/前
--   C-Space   補完メニューを開く
--   C-e       補完メニューを閉じる
-- =============================================================

-- =============================================================
-- Window/Buffer Keymaps (VS Codeライク)
-- =============================================================
local function map(mode, lhs, rhs, desc)
	vim.keymap.set(mode, lhs, rhs, { desc = desc })
end

-- Window (VS Code: Ctrl+W prefix → <leader>w)
map("n", "<leader>wh", "<C-w>h", "Window left")
map("n", "<leader>wj", "<C-w>j", "Window down")
map("n", "<leader>wk", "<C-w>k", "Window up")
map("n", "<leader>wl", "<C-w>l", "Window right")
map("n", "<leader>wv", "<C-w>v", "Split vertical")
map("n", "<leader>ws", "<C-w>s", "Split horizontal")
map("n", "<leader>wc", "<C-w>c", "Close window")
map("n", "<leader>wo", "<C-w>o", "Close other windows")
map("n", "<leader>w=", "<C-w>=", "Equalize windows")
map("n", "<leader>w|", "<C-w>|", "Max width")
map("n", "<leader>w_", "<C-w>_", "Max height")

-- Buffer (VS Code: Ctrl+Tab / Ctrl+Shift+Tab)
map("n", "<leader>bn", "<cmd>bnext<cr>", "Next buffer")
map("n", "<leader>bp", "<cmd>bprevious<cr>", "Prev buffer")
map("n", "<leader>bd", "<cmd>bdelete<cr>", "Delete buffer")
map("n", "<leader>bD", "<cmd>bdelete!<cr>", "Force delete buffer")
map("n", "<leader>bo", "<cmd>%bdelete|e#<cr>", "Delete other buffers")
map("n", "<Tab>", "<cmd>bnext<cr>", "Next buffer")
map("n", "<S-Tab>", "<cmd>bprevious<cr>", "Prev buffer")

-- Tab (VS Code: Ctrl+PgUp/PgDn)
map("n", "<leader>tn", "<cmd>tabnew<cr>", "New tab")
map("n", "<leader>tc", "<cmd>tabclose<cr>", "Close tab")
map("n", "<leader>to", "<cmd>tabonly<cr>", "Close other tabs")
map("n", "]t", "<cmd>tabnext<cr>", "Next tab")
map("n", "[t", "<cmd>tabprevious<cr>", "Prev tab")
map("n", "[T", "<cmd>tabfirst<cr>", "First tab")
map("n", "]T", "<cmd>tablast<cr>", "Last tab")

-- Terminal
map("t", "<C-\\>", "<C-\\><C-n>", "Terminal normal mode")
map("t", "<C-h>", "<cmd>wincmd h<cr>", "Terminal left")
map("t", "<C-j>", "<cmd>wincmd j<cr>", "Terminal down")
map("t", "<C-k>", "<cmd>wincmd k<cr>", "Terminal up")
map("t", "<C-l>", "<cmd>wincmd l<cr>", "Terminal right")

-- =============================================================
-- General Keymaps
-- =============================================================
map("n", "<leader>qq", "<cmd>qa<cr>", "Quit all")
-- Save: <C-s> (VS Code style) and <leader>fs (file save)
map("n", "<C-s>", "<cmd>update<cr>", "Save")
map("i", "<C-s>", "<cmd>update<cr>", "Save")
map("n", "<leader>fs", "<cmd>update<cr>", "File save")
map("n", "<leader>fS", "<cmd>wall<cr>", "File save all")
map("n", "<Esc>", "<cmd>nohlsearch<cr>", "Clear search highlight")
map("n", "<leader>cl", "<cmd>nohlsearch<cr>", "Clear search highlight")
map("n", "<C-l>", "<cmd>nohlsearch<bar>diffupdate<cr>", "Clear search + diffupdate")

-- Base.vim keymaps
map("i", "jj", "<ESC>", "Exit insert mode")
map("i", "<C-l>", "<Del>", "Delete forward")
map("n", "gf", "gF", "Open file under cursor")

-- Better indent (stay in visual mode)
map("v", "<", "<gv", "Indent left")
map("v", ">", ">gv", "Indent right")

-- Move lines
map("n", "<A-j>", "<cmd>m .+1<cr>==", "Move line down")
map("n", "<A-k>", "<cmd>m .-2<cr>==", "Move line up")
map("v", "<A-j>", ":m '>+1<cr>gv=gv", "Move selection down")
map("v", "<A-k>", ":m '<-2<cr>gv=gv", "Move selection up")

-- Quickfix
map("n", "<leader>xq", "<cmd>copen<cr>", "Quickfix open")
map("n", "<leader>xc", "<cmd>cclose<cr>", "Quickfix close")
map("n", "[q", "<cmd>cprevious<cr>", "Quickfix prev")
map("n", "]q", "<cmd>cnext<cr>", "Quickfix next")

-- Diagnostics list
map("n", "<leader>xx", "<cmd>Telescope diagnostics<cr>", "All diagnostics")
map("n", "<leader>xb", "<cmd>Telescope diagnostics bufnr=0<cr>", "Buffer diagnostics")

-- =============================================================
-- Cargo (競プロ用)
-- =============================================================
local function cargo_compete(cmd)
	if vim.fn.executable("cargo") == 0 then
		vim.notify("cargo not found", vim.log.levels.WARN)
		return
	end
	vim.cmd("botright split | terminal cargo compete " .. cmd)
	vim.cmd("startinsert")
end

map("n", "<leader>an", function() cargo_compete("new") end, "Cargo compete new")
map("n", "<leader>ac", function() cargo_compete("") end, "Cargo compete interactive")
map("n", "<leader>at", function() cargo_compete("test") end, "Cargo compete test")
map("n", "<leader>as", function() cargo_compete("submit") end, "Cargo compete submit")

-- =============================================================
-- Snippet Management Commands
-- =============================================================
vim.api.nvim_create_user_command("SnippetEdit", function(opts)
	local lang = opts.args ~= "" and opts.args or vim.bo.filetype
	local snippet_dir = vim.fn.expand("~/.dotfiles/home/snippets")
	local file = snippet_dir .. "/" .. lang .. ".json"
	if vim.fn.filereadable(file) == 0 then
		vim.fn.mkdir(snippet_dir, "p")
		vim.fn.writefile({ "{}" }, file)
	end
	vim.cmd("edit " .. file)
end, { nargs = "?", desc = "Edit snippets for language" })

vim.api.nvim_create_user_command("SnippetReload", function()
	require("luasnip.loaders.from_vscode").load({ paths = { vim.fn.expand("~/.dotfiles/home/snippets") } })
	require("luasnip.loaders.from_vscode").load({ paths = { vim.fn.expand("~/.local/share/nvim/lazy/friendly-snippets") } })
	vim.notify("Snippets reloaded", vim.log.levels.INFO)
end, { desc = "Reload snippets from dotfiles" })

-- =============================================================
-- 共通設定読み込み (Vim/Neovim共通)
-- =============================================================
local shared = vim.fn.expand("~/vimfiles/shared/base.vim")
if vim.fn.filereadable(shared) == 1 then
	vim.cmd.source(shared)
end