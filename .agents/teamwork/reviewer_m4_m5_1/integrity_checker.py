import re

with open('pc_worker/surveying/construction_qa.py', encoding='utf-8') as f:
    text = f.read()

print('Searching for scan_id hardcoding or mock results in construction_qa.py:')
matches = []
for idx, line in enumerate(text.splitlines()):
    l = line.strip()
    if 'test_' in l.lower() or 'quchi' in l.lower() or 'mock' in l.lower() or 'fake' in l.lower():
        matches.append((idx + 1, l))

if not matches:
    print('ZERO hardcoded test scans, mocks, or fake returns found!')
else:
    for line_no, l in matches:
        print(f'Line {line_no}: {l}')

# Also check for hardcoded test scores or results
suspicious = []
for idx, line in enumerate(text.splitlines()):
    l = line.strip()
    if re.search(r'if.*(quchi|rosepark|ntudorm|test).*:', l):
        suspicious.append((idx + 1, l))

if not suspicious:
    print('ZERO conditional branches on test scan IDs found!')
else:
    for line_no, l in suspicious:
        print(f'Line {line_no}: {l}')
