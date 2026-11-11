#!/usr/bin/env python3
"""
Bidirectional snippet sync between VS Code and Neovim (dotfiles).

Source of truth: ~/.dotfiles/home/snippets/
- VS Code: symlinks from ~/Library/Application Support/Code/User/snippets/*.json to dotfiles
- Neovim: loads directly from ~/.dotfiles/home/snippets/ via LuaSnip

This script:
1. Creates symlinks for VS Code (run once on setup)
2. Can be used to verify sync status
"""

import json
import os
import sys
import platform
from pathlib import Path

DOTFILES_SNIPPETS = Path.home() / ".dotfiles" / "home" / "snippets"

def get_vscode_snippets_dir():
    """Get VS Code snippets directory for current platform."""
    system = platform.system().lower()
    if system == "darwin":
        return Path.home() / "Library" / "Application Support" / "Code" / "User" / "snippets"
    elif system == "windows":
        return Path(os.environ.get("APPDATA", "")) / "Code" / "User" / "snippets"
    else:  # Linux/WSL
        # Check for Cursor first, then VS Code
        cursor_dir = Path.home() / ".config" / "Cursor" / "User" / "snippets"
        if cursor_dir.exists():
            return cursor_dir
        return Path.home() / ".config" / "Code" / "User" / "snippets"

VSCODE_SNIPPETS = get_vscode_snippets_dir()
def ensure_dirs():
    DOTFILES_SNIPPETS.mkdir(parents=True, exist_ok=True)
    VSCODE_SNIPPETS.mkdir(parents=True, exist_ok=True)

def create_vscode_symlinks():
    """Create symlinks from VS Code snippets dir to dotfiles snippets."""
    ensure_dirs()
    created = 0
    skipped = 0
    errors = 0

    for src in DOTFILES_SNIPPETS.glob("*.json"):
        if src.name == "package.json":
            continue
        dst = VSCODE_SNIPPETS / src.name
        if dst.exists() or dst.is_symlink():
            if dst.is_symlink() and dst.resolve() == src.resolve():
                skipped += 1
                continue
            else:
                print(f"Conflict: {dst} exists and is not a symlink to {src}")
                errors += 1
                continue
        try:
            dst.symlink_to(src)
            print(f"Linked: {dst} -> {src}")
            created += 1
        except OSError as e:
            print(f"Error linking {dst}: {e}")
            errors += 1

    print(f"Created: {created}, Skipped: {skipped}, Errors: {errors}")
    return errors == 0

def verify_sync():
    """Verify that VS Code snippets match dotfiles."""
    ensure_dirs()
    ok = True
    is_windows = platform.system().lower() == "windows"
    
    for src in DOTFILES_SNIPPETS.glob("*.json"):
        if src.name == "package.json":
            continue
        dst = VSCODE_SNIPPETS / src.name
        dst_str = str(dst)
        src_str = str(src)
        
        if is_windows:
            # Use os.path for better symlink detection on Windows
            if not os.path.lexists(dst_str):
                print(f"Missing: {dst}")
                ok = False
            elif os.path.islink(dst_str):
                try:
                    real_dst = os.path.realpath(dst_str)
                    real_src = os.path.realpath(src_str)
                    if real_dst != real_src:
                        print(f"Wrong target: {dst} -> {real_dst} (expected {real_src})")
                        ok = False
                except OSError:
                    print(f"Error resolving symlink: {dst}")
                    ok = False
            else:
                # Compare content
                with open(src_str, encoding='utf-8') as f1, open(dst_str, encoding='utf-8') as f2:
                    if f1.read() != f2.read():
                        print(f"Content differs: {dst}")
                        ok = False
        else:
            # Unix-like: use pathlib
            if not dst.exists():
                print(f"Missing: {dst}")
                ok = False
            elif dst.is_symlink():
                if dst.resolve() != src.resolve():
                    print(f"Wrong target: {dst} -> {dst.resolve()} (expected {src})")
                    ok = False
            else:
                with open(src, encoding='utf-8') as f1, open(dst, encoding='utf-8') as f2:
                    if f1.read() != f2.read():
                        print(f"Content differs: {dst}")
                        ok = False
    if ok:
        print("All snippets in sync")
    return ok

def sync_vscode_to_dotfiles():
    """Copy snippets from VS Code to dotfiles (for initial migration)."""
    ensure_dirs()
    copied = 0
    for src in VSCODE_SNIPPETS.glob("*.json"):
        dst = DOTFILES_SNIPPETS / src.name
        try:
            with open(src, encoding='utf-8') as f:
                content = f.read()
            # Validate JSON
            json.loads(content)
            with open(dst, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f"Copied: {src} -> {dst}")
            copied += 1
        except json.JSONDecodeError as e:
            print(f"Invalid JSON in {src}: {e}")
        except OSError as e:
            print(f"Error copying {src}: {e}")
    print(f"Copied {copied} snippet files")
    return copied > 0

def main():
    if len(sys.argv) < 2:
        print("Usage: snippet-sync.py {link|verify|import}")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "link":
        ok = create_vscode_symlinks()
        sys.exit(0 if ok else 1)
    elif cmd == "verify":
        ok = verify_sync()
        sys.exit(0 if ok else 1)
    elif cmd == "import":
        ok = sync_vscode_to_dotfiles()
        sys.exit(0 if ok else 1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

if __name__ == "__main__":
    main()