-- Thin Neovim entry point. Windows reads it from %LOCALAPPDATA%\nvim
-- (home/AppData/Local/nvim/init.lua), POSIX from ~/.config/nvim
-- (home/.config/nvim/init.lua); the two files are byte-identical on purpose
-- and source the one canonical config, home/vimfiles/nvim/init.lua, so the
-- 281-line configuration is never duplicated across operating systems.
local shared = vim.fn.expand("~/vimfiles/nvim/init.lua")
if vim.fn.filereadable(shared) == 1 then
	vim.cmd.source(shared)
else
	vim.notify("dotfiles: missing " .. shared .. " (run script/link)", vim.log.levels.WARN)
end
