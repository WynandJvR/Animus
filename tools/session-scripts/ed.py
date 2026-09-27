# ed.py <file> <edits.py-module-with-EDITS=[(old,new),...]> : exact replacements on LF-normalized text, original EOL kept
import sys, importlib.util
f = sys.argv[1]
spec = importlib.util.spec_from_file_location('e', sys.argv[2]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
raw = open(f, encoding='utf8', newline='').read()
crlf = raw.count('\r\n') > raw.count('\n') / 2
s = raw.replace('\r\n', '\n')
for old, new in m.EDITS:
    n = s.count(old)
    if n != 1: sys.exit(f'{f}: expected 1 match, got {n} for: {old[:80]!r}')
    s = s.replace(old, new)
open(f, 'w', encoding='utf8', newline='').write(s.replace('\n', '\r\n') if crlf else s)
print(f'{f}: {len(m.EDITS)} edit(s), {"CRLF" if crlf else "LF"}')
