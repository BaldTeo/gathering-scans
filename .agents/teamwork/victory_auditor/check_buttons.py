import re

pattern = re.compile(r'<button\b([^>]*)>(.*?)</button>', re.DOTALL | re.IGNORECASE)
tag_clean = re.compile(r'<[^>]+>')
files = [
    'web/src/09-construction-survey-and-bim.js',
    'web/src/10-construction-qa-and-stakeout.js',
    'web/src/11-scan-to-bim-primitives.js',
    'web/src/12-public-utilities-gis.js'
]
# match t("zh", "en") or tr("zh", "en")
tr_pattern = re.compile(r'(?:tr|t)\(\s*["\']([^"\']+)["\']\s*,\s*["\']([^"\']+)["\']\s*\)')

all_buttons = []
violations = []

for fpath in files:
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()
    matches = pattern.findall(content)
    for attrs, raw in matches:
        # Check if there is tr("zh", "en") or t("zh", "en")
        tr_matches = tr_pattern.findall(raw)
        if tr_matches:
            for zh, en in tr_matches:
                all_buttons.append((fpath, zh, en))
                en_words = en.split()
                # 1-word rule
                if len(en_words) > 1:
                    violations.append((fpath, f't/tr({zh!r}, {en!r})', f'English has {len(en_words)} words: {en}'))
        else:
            text = tag_clean.sub('', raw).strip()
            # remove template variables
            text = re.sub(r'\$\{.*?\}', '', text).strip()
            if text:
                words = text.split()
                all_buttons.append((fpath, text, text))
                if len(words) > 1:
                    violations.append((fpath, text, f'Multiple words: {text}'))

print(f"Total buttons checked: {len(all_buttons)}")
print(f"Violations count: {len(violations)}")
for b in all_buttons:
    print(f"  {b[0].split('/')[-1]}: [{b[1]} / {b[2]}]")
if violations:
    for v in violations:
        print("VIOLATION:", v)
else:
    print("SUCCESS: Strictly 1-word button labels across all new frontend files!")
