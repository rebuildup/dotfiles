import json
import os
import sys

def strip_jsonc(s):
    """Strip // and /* */ comments from JSONC text, respecting strings."""
    result = []
    i = 0
    n = len(s)
    in_string = False
    while i < n:
        c = s[i]
        if in_string:
            result.append(c)
            if c == '\\' and i + 1 < n:
                result.append(s[i + 1])
                i += 2
                continue
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            result.append(c)
            i += 1
        elif c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
        elif c == '/' and i + 1 < n and s[i + 1] == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                i += 1
            i += 2
        else:
            result.append(c)
            i += 1
    return ''.join(result)


def main():
    src = os.path.join(
        os.environ['APPDATA'], 'Code', 'User', 'snippets', 'rust.json'
    )
    dst = os.path.join(
        os.environ['LOCALAPPDATA'], 'nvim', 'snippets', 'rust.json'
    )

    with open(src, 'r', encoding='utf-8') as f:
        content = f.read()

    clean = strip_jsonc(content)
    parsed = json.loads(clean)
    print(f"Parsed OK, {len(parsed)} snippets")

    # dst is a dotfiles symlink into the repository. Writing through the
    # resolved target keeps the managed entry a link; removing dst first would
    # replace it with an unmanaged copy that script/check reports as drift.
    target = os.path.realpath(dst)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    # Parse before touching the destination, then swap atomically so a failed
    # run cannot leave a half-written snippet file behind.
    tmp = target + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(clean)
    os.replace(tmp, target)
    print(f"Wrote {target}")


if __name__ == '__main__':
    main()
