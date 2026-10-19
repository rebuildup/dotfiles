" 大西配列 (Onishi) 対応 vim キーマップ
"
" 前提:
"   ChgKey の Scancode Map によって、OS に届く文字は QWERTY の位置ではなく
"   大西配列の文字になる。標準配列の位置と実際の文字の対応:
"
"     位置   Q W E R T   A S D F G   Y U I O P
"     文字   q l u , .   e i a o =   f w r y p
"
"     位置   H J K L ;   Z X C V B   , . /
"     文字   k t n s h   z x c v ;   m j b
"
" 方針:
"   vim の既定マッピングのうち「QWERTY の物理位置を前提にしている」ものだけを
"   大西配列の文字へ移す。QWERTY で菱形に隣接していた hjkl の位置には
"   大西では k t n s が居るので、方向操作はこちらへ割り当てる。
"
"   一方 d / c / y / w / b / f のような「語の頭文字に由来する」割り当ては
"   位置ではなく意味で決まっているため、そのまま残す。
"
" 変更点:
"   方向移動   k = 左   t = 下   n = 上   s = 右
"   画面移動   K / J / H / L は vim 既定のまま
"   エイリアス h / j / l は元 hjkl と同じ動作
"
"   上書きで失ったコマンドは大文字へ退避:
"     T = till  ('t' の後身)
"     N = 次の一致  ('n' の後身)
"     S = 置換  ('s' の後身)
"     , = 前の一致  ('N' の後身)
"
" <expr> と nr2char で生の文字を返す。noremap なので再マッピングされず、
" vim の既定の動作がそのまま実行される。

" --- 方向移動 -------------------------------------------------------------
nnoremap <silent> <expr> k nr2char(104)
nnoremap <silent> <expr> t nr2char(106)
nnoremap <silent> <expr> n nr2char(107)
nnoremap <silent> <expr> s nr2char(108)

" 元の hjkl も同じ動作のエイリアスとして残す
nnoremap <silent> <expr> h nr2char(104)
nnoremap <silent> <expr> j nr2char(106)
nnoremap <silent> <expr> l nr2char(108)

" --- 画面移動 -------------------------------------------------------------
nnoremap <silent> <expr> K nr2char(75)
nnoremap <silent> <expr> J nr2char(74)
nnoremap <silent> <expr> H nr2char(72)
nnoremap <silent> <expr> L nr2char(76)

" --- 退避したコマンド ------------------------------------------------------
nnoremap <silent> <expr> T nr2char(116)
nnoremap <silent> <expr> N nr2char(110)
nnoremap <silent> <expr> S nr2char(115)
nnoremap <silent> <expr> , nr2char(78)

" --- 演算子入力中 (dt や ys など) -----------------------------------------
onoremap <silent> <expr> k nr2char(104)
onoremap <silent> <expr> t nr2char(106)
onoremap <silent> <expr> n nr2char(107)
onoremap <silent> <expr> s nr2char(108)
onoremap <silent> <expr> h nr2char(104)
onoremap <silent> <expr> j nr2char(106)
onoremap <silent> <expr> l nr2char(108)
onoremap <silent> <expr> T nr2char(116)

" --- ビジュアルモード ------------------------------------------------------
xnoremap <silent> <expr> k nr2char(104)
xnoremap <silent> <expr> t nr2char(106)
xnoremap <silent> <expr> n nr2char(107)
xnoremap <silent> <expr> s nr2char(108)
xnoremap <silent> <expr> h nr2char(104)
xnoremap <silent> <expr> j nr2char(106)
xnoremap <silent> <expr> l nr2char(108)
xnoremap <silent> <expr> S nr2char(115)