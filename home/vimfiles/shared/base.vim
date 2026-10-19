scriptencoding utf-8
" ============================================================
" 共通設定 (Vim / Neovim 共通)
"
" 由来:
"   yasunori0418/dotfiles home/.vimrc
"   https://github.com/yasunori0418/dotfiles/blob/0fb4280199581af9a0b19cdea9f8c61a54f89c03/home/.vimrc
"
" 読み込み方:
"   Vim     : _vimrc      から source
"   Neovim  : init.lua    から vim.cmd('source ...')
"
" Vim と Neovim で挙動が異なる設定 (文字コード、backup file) は
" if has('nvim') で分けている。
" ============================================================

" --- 文字コード --------------------------------------------------------
" Neovim は常に UTF-8 固定なので触らない。
if !has('nvim')
  set encoding=utf-8
  set fileencoding=utf-8
  set fileencodings=utf-8,sjis,iso-2022-jp,euc-jp
endif

" 改行コードは LF と CRLF を自動判別
set fileformats=unix,dos

" --- キャッシュ置き場 ----------------------------------------------------
" backup / swap / undo を ~/.cache/vim 以下にまとめる。
" 元の dotfiles は undodir だけ条件が逆で作成されないので、
" ここでは 3 つとも同じ方針で作成する。
let s:cache_dir = expand('~/.cache/vim')
for s:sub in ['backup', 'swap', 'undo']
  if !isdirectory(s:cache_dir . '/' . s:sub)
    call mkdir(s:cache_dir . '/' . s:sub, 'p')
  endif
endfor
execute 'set backupdir=' . s:cache_dir . '/backup'
execute 'set directory=' . s:cache_dir . '/swap'
execute 'set undodir=' . s:cache_dir . '/undo'
set undofile

" Vim のみ backup file (~) を作る。
" Neovim は undo file + swapfile で復旧でき、~ ファイルは telescope
" などのファイル検索にノイズになるため作らない。
if !has('nvim')
  set backup
endif

" --- 挙動 --------------------------------------------------------------
" 東アジアの ambiguous 文字幅を 1 桁に固定
set ambiwidth=single

" ファイルが後から変わったら自動で読み直す
set autoread

" 行末を越えてカーソルを動かせるようにする
set virtualedit=block

" Windows は OS クリップボードが既定で有効化されているので unnamedplus は不要
if !has('win32') && !has('win64')
  set clipboard+=unnamedplus
endif

" diff を縦並び・行の差を強調
set diffopt+=vertical,algorithm:histogram,indent-heuristic

" ビープを鳴らさない
set belloff=all

" --- 表示 --------------------------------------------------------------
set number
set relativenumber
set cursorline

" --- 折りたたみ --------------------------------------------------------
set foldmethod=marker
set foldlevel=0
set foldcolumn=3

" --- 検索 --------------------------------------------------------------
set hlsearch
set incsearch
set ignorecase
set smartcase
set wrapscan

" --- インデント --------------------------------------------------------
set smartindent
set expandtab
set shiftwidth=2
set tabstop=2
set softtabstop=2

augroup filetypeIndent
  autocmd!
  autocmd FileType html   setlocal tabstop=2 softtabstop=2 shiftwidth=2
  autocmd FileType css    setlocal tabstop=2 softtabstop=2 shiftwidth=2
  autocmd FileType python setlocal tabstop=4 softtabstop=4 shiftwidth=4
  autocmd FileType php    setlocal tabstop=4 softtabstop=4 shiftwidth=4
augroup END

" --- ステータスライン ----------------------------------------------------
set laststatus=2
set wildmenu
set history=5000

" --- 不可視文字 --------------------------------------------------------
set list
set listchars=tab:»-,space:･,trail:･,nbsp:%,eol:↲,extends:»,precedes:«

" --- キーマップ: ウィンドウ操作 ----------------------------------------
" <Space>w を prefix にして <Plug>(window) を叩く形。
" 例: <Space>ww で保存、<Space>wv で縦分割
nmap <Space>w <Plug>(window)

nnoremap <Plug>(window)h <C-W>h
nnoremap <Plug>(window)j <C-W>j
nnoremap <Plug>(window)k <C-W>k
nnoremap <Plug>(window)l <C-W>l

" 画面の端まで移動
nnoremap <Plug>(window)H <C-W>H
nnoremap <Plug>(window)J <C-W>J
nnoremap <Plug>(window)K <C-W>K
nnoremap <Plug>(window)L <C-W>L

" タブページ操作
nnoremap [t gT
nnoremap ]t gt
nnoremap [T <Cmd>tabfirst<CR>
nnoremap ]T <Cmd>tablast<CR>
nnoremap <Plug>(window)tn <Cmd>tabnew<CR>
nnoremap <Plug>(window)tT <C-W>T

" ウィンドウを閉じる
nnoremap <Plug>(window)q <C-W>q
nnoremap <Plug>(window)Q <Cmd>quit!<CR>

" 変更があるときだけ保存
nnoremap <Plug>(window)w <Cmd>update<CR>

" 分割
nnoremap <Plug>(window)s <C-W>s
nnoremap <Plug>(window)v <C-W>v
nnoremap <Plug>(window)n <C-W>n

" サイズ変更
nnoremap <Plug>(window)<Bar> <C-W><Bar>
nnoremap <Plug>(window)_ <C-W>_
nnoremap <Plug>(window)= <C-W>=

" --- キーマップ: ノーマルモード ----------------------------------------
" x / c で消した文字をレジスタに残さない
nnoremap x "_x
nnoremap c "_c

" カーソル下のファイル名を編集状態で開く
nnoremap gf gF

" 検索ハイライトを消す
nnoremap <C-l> <Cmd>nohlsearch<Bar>diffupdate<CR><C-l>

" --- キーマップ: インサートモード --------------------------------------
inoremap jj <ESC>
inoremap <C-l> <Del>

" --- キーマップ: ビジュアルモード --------------------------------------
xnoremap x "_x
xnoremap c "_c

" --- シンタックス / ファイルタイプ --------------------------------------
filetype plugin indent on
syntax on

" --- 背景の透過 --------------------------------------------------------
" 端末の背景を透かす。
" 'background' に transparent を指定する書き方は Vim でも Neovim でも
" E474 になるので、guibg=NONE でハイライト側だけ背景を落とす。
" Vim 側 (_vimrc 経由) と Neovim 側 (init.lua 経由) で同じ関数を共有する。
" :colorscheme で配色し直した後にも ColorScheme ごとに掛け直す。
function! s:TransparentBG() abort
  for s:hl in ['Normal', 'NormalNC', 'SignColumn', 'EndOfBuffer']
    execute 'silent! highlight ' . s:hl . ' guibg=NONE ctermbg=NONE'
  endfor
endfunction

call s:TransparentBG()

augroup transparentBG
  autocmd ColorScheme * call s:TransparentBG()
augroup END

" 大西配列対応のキー配置は最後に読み込む (上の既定マッピングを上書きするため)
if filereadable(expand('~/vimfiles/keymap/onishi.vim'))
  source ~/vimfiles/keymap/onishi.vim
endif