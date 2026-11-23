" POSIX entry point for Vim. Windows uses the install-dir entry at
" home/AppData/Local/Programs/Vim/_vimrc; both files only source shared
" configuration, nothing is configured here.
"
" vimrc_example.vim is the portable runtime template (its own header says
" "for Unix: ~/.vimrc") and it pulls in $VIMRUNTIME/defaults.vim. Sourcing it
" matters on Unix: with a user vimrc present Vim no longer auto-loads
" defaults.vim, so skipping the template would regress scrolloff/mouse/ttimeout
" that this machine has today. base.vim runs last and overrides every option it
" shares with the template, in the same order as the Windows entry.
if filereadable(expand('$VIMRUNTIME/vimrc_example.vim'))
  source $VIMRUNTIME/vimrc_example.vim
endif

" The Windows-only `set diffexpr=MyDiff()` block is intentionally skipped:
" Vim 9 lists 'internal' in 'diffopt' on every platform (verified:
" diffopt=internal,filler,...), so MyDiff never runs on Windows either.

" 共通設定 (大西配列のキーマップ・背景透過を含む)
if filereadable(expand("~/vimfiles/shared/base.vim"))
  source ~/vimfiles/shared/base.vim
endif
