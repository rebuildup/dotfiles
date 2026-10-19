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

require("lazy").setup({
	spec = {
		-- 補完(blink.cmpは内部で遅延)
		{
			"saghen/blink.cmp",
			version = "1.*",
			dependencies = {
				"rafamadriz/friendly-snippets",
			},
			event = { "BufReadPost", "BufNewFile" },
			opts = {
				-- キー設定は下で明示("preset = none"にして競合を避ける)
				keymap = {
					preset = "none",
					["<C-n>"] = { "select_next", "fallback" },
					["<C-p>"] = { "select_prev", "fallback" },
					["<C-Space>"] = { "show", "fallback" },
					["<C-e>"] = { "hide", "fallback" },
					["<C-d>"] = { "scroll_documentation_down", "fallback" },
					["<C-u>"] = { "scroll_documentation_up", "fallback" },
					-- Tab / Enter / Shift-Tab は下のsmart_key()で一元処理
				},
				completion = {
					documentation = {
						auto_show = true,
					},
				},
				sources = {
					default = {
						"lsp",
						"path",
						"snippets",
						"buffer",
					},
				},
			},
		},

		-- Git差分表示(バッファ読込時のみ)
		{
			"lewis6991/gitsigns.nvim",
			event = { "BufReadPost", "BufNewFile" },
			opts = {},
		},

		-- ファイル・全文検索(コマンド起動時のみ)
		{
			"nvim-telescope/telescope.nvim",
			cmd = "Telescope",
			keys = {
				{ "<leader>ff", "<cmd>Telescope find_files<cr>", desc = "Find files" },
				{ "<leader>fg", "<cmd>Telescope live_grep<cr>", desc = "Live grep" },
				{ "<leader>fb", "<cmd>Telescope buffers<cr>", desc = "Buffers" },
				{ "<leader>fh", "<cmd>Telescope help_tags<cr>", desc = "Help tags" },
			},
			dependencies = {
				"nvim-lua/plenary.nvim",
			},
		},

		-- formatter(保存時のみ)
		{
			"stevearc/conform.nvim",
			event = { "BufWritePre" },
			cmd = { "ConformInfo" },
			opts = {
				format_on_save = {
					timeout_ms = 1000,
					lsp_format = "fallback",
				},

				formatters_by_ft = {
					rust = { "rustfmt" },
					lua = { "stylua" },
				},
			},
		},

		-- MasonはUI用、使うときだけ起動
		{
			"mason-org/mason.nvim",
			cmd = { "Mason", "MasonInstall", "MasonUninstall", "MasonUpdate" },
			keys = {
				{ "<leader>mi", "<cmd>MasonInstall<cr>", desc = "Mason install" },
			},
			opts = {},
		},

		{
			"neovim/nvim-lspconfig",
			event = { "BufReadPost", "BufNewFile" },
		},
	},
})

vim.lsp.enable({
	"rust_analyzer",
	"lua_ls",
})

-- rust-analyzer: 型ヒント有効、リアルタイム診断有効、起動は軽量化
vim.lsp.config("rust_analyzer", {
	settings = {
		["rust-analyzer"] = {
			inlayHints = {
				enable = true,
				parameterHints = true,
				typeHints = true,
				chainingHints = true,
				closingBraceHints = true,
				macroHints = true,
			},
			check = {
				workspace = false,
				command = "clippy",
			},
			cargo = {
				allFeatures = false,
				buildScripts = false,
			},
			completion = {
				autoimport = { enable = false },
			},
			imports = {
				granularity = "Item",
				group = true,
			},
			diagnostics = {
				enable = true,
				experimental = { enable = true },
			},
		},
	},
})

-- inlay hintsトグル(\ih)
vim.keymap.set("n", "<leader>ih", function()
	local ih = vim.lsp.inlay_hint or vim.lsp.buf and vim.lsp.buf.inlay_hint
	-- nvim 0.10+: vim.lsp.inlay_hint.is_enabled()
	if vim.lsp.inlay_hint then
		if vim.lsp.inlay_hint.is_enabled({ bufnr = 0 }) then
			vim.lsp.inlay_hint.disable({ bufnr = 0 })
		else
			vim.lsp.inlay_hint.enable({ bufnr = 0 })
		end
	end
end, { desc = "toggle inlay hints" })

-- =============================================================
-- 補完キーマップ(明示)
-- =============================================================
-- 優先順位:
--   1. snippet placeholder内        → vim.snippet.jump (Tab/Shift-Tab)
--   2. blink.cmpの補完メニュー表示中 → accept / select_prev (Tab/Enter/Shift-Tab)
--   3. それ以外                      → 通常のキー入力をそのまま流す
--
--   Tab      補完確定 / snippet次 / 通常のTab
--   Shift+Tab 補完prev / snippet前 / 通常のShift+Tab
--   Enter    補完確定 / 通常の改行
--   C-n/p    補完候補を次/前
--   C-Space  補完メニューを手動で開く
--   C-e      補完メニューを閉じる
-- =============================================================

local function smart_key(key)
	return function()
		-- 1. snippet placeholderへのジャンプを優先
		if vim.snippet and vim.snippet.jumpable and vim.snippet.jumpable(1) then
			vim.snippet.jump(1)
			return
		end
		-- 2. 補完メニュー表示中ならaccept
		local ok, cmp = pcall(require, "blink.cmp")
		if ok and cmp.is_visible() then
			cmp.accept({})
			return
		end
		-- 3. それ以外は通常のキー入力をそのまま流す
		local keys = vim.api.nvim_replace_termcodes(key, true, false, true)
		vim.api.nvim_feedkeys(keys, "n", false)
	end
end

vim.keymap.set("i", "<Tab>", smart_key("<Tab>"), { desc = "Tab: snippet→cmp→fallback" })
vim.keymap.set("i", "<S-Tab>", function()
	if vim.snippet and vim.snippet.jumpable and vim.snippet.jumpable(-1) then
		vim.snippet.jump(-1)
		return
	end
	local ok, cmp = pcall(require, "blink.cmp")
	if ok and cmp.is_visible() then
		cmp.select_prev()
		return
	end
	local keys = vim.api.nvim_replace_termcodes("<S-Tab>", true, false, true)
	vim.api.nvim_feedkeys(keys, "n", false)
end, { desc = "Shift-Tab: snippet→cmp prev→fallback" })

vim.keymap.set("i", "<CR>", smart_key("<CR>"), { desc = "Enter: cmp accept→fallback" })

-- リアルタイム診断: virtual_text / signs を明示有効化
vim.diagnostic.config({
	virtual_text = {
		prefix = "■",
		spacing = 2,
		source = true, -- どのLSP由来か表示
	},
	signs = true,
	severity_sort = true,
	underline = true,
	float = {
		source = true,
		border = "rounded",
	},
	update_in_insert = false, -- 入力中は更新しない(重くしない)
})

-- Cargo(競プロ用ターミナル開閉ヘルパー)
local function cargo_compete(cmd)
	if vim.fn.executable("cargo") == 0 then
		vim.notify("cargo not found", vim.log.levels.WARN)
		return
	end
	local term_cmd = "cargo compete" .. (cmd and (" " .. cmd) or "")
	vim.cmd("botright split")
	vim.cmd("terminal " .. term_cmd)
	local term_buf = vim.api.nvim_get_current_buf()

	-- ターミナルが閉じられたら現在のバッファをrustfmtでフォーマット
	vim.api.nvim_create_autocmd({ "BufWinLeave", "WinClosed" }, {
		buffer = term_buf,
		once = true,
		nested = true,
		callback = function()
			vim.schedule(function()
				local ok, conform = pcall(require, "conform")
				if ok then
					conform.format({ async = true, lsp_format = "fallback" })
				end
			end)
		end,
	})
end

vim.keymap.set("n", "<leader>an", function() cargo_compete("new") end, { desc = "cargo compete new" })
vim.keymap.set("n", "<leader>ac", function() cargo_compete("") end, { desc = "cargo compete (interactive)" })
vim.keymap.set("n", "<leader>at", function() cargo_compete("test") end, { desc = "cargo compete test" })
vim.keymap.set("n", "<leader>as", function() cargo_compete("submit") end, { desc = "cargo compete submit" })

-- 背景の透過と大西配列のキーマップは ~/vimfiles/shared/base.vim に集約している
-- (Vim 側の _vimrc と同じファイルを読み込む)。
local shared = vim.fn.expand("~/vimfiles/shared/base.vim")
if vim.fn.filereadable(shared) == 1 then
	vim.cmd.source(shared)
end
