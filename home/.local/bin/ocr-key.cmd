@echo off
setlocal
bun "%USERPROFILE%\.dotfiles\script\ocr-key.ts" %*
exit /b %errorlevel%
