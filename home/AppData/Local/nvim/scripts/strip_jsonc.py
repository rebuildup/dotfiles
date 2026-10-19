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
    src = r'C:\Users\rebui\AppData\Roaming\Code\User\snippets\rust.json'
    dst = r'C:\Users\rebui\AppData\Local\nvim\snippets\rust.json'

    if os.path.islink(dst):
        os.unlink(dst)
    elif os.path.exists(dst):
        os.remove(dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    with open(src, 'r', encoding='utf-8') as f:
        content = f.read()

    clean = strip_jsonc(content)
    parsed = json.loads(clean)
    print(f"Parsed OK, {len(parsed)} snippets")

    with open(dst, 'w', encoding='utf-8') as f:
        f.write(clean)
    print(f"Wrote {dst}")


if __name__ == '__main__':
    main()
