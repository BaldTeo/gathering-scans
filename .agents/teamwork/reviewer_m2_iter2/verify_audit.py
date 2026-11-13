import re
import sys

# Ensure utf-8 output
sys.stdout.reconfigure(encoding='utf-8')

with open("web/src/09-construction-survey-and-bim.js", encoding="utf-8") as f:
    content = f.read()

btn_pattern = re.compile(r"<(button|a)[^>]*>(.*?)</\1>", re.DOTALL)
matches = btn_pattern.findall(content)

print(f"Total buttons/links found: {len(matches)}")
all_1_word = True
for tag, inner in matches:
    clean = re.sub(r"<svg.*?</svg>", "", inner, flags=re.DOTALL)
    clean = re.sub(r"\$\{SVG_ICONS\.[A-Z0-9_]+\}", "", clean)
    clean = re.sub(r"<[^>]+>", "", clean)
    clean = clean.strip()
    t_match = re.findall(r'\$\{t\(\"([^\"]+)\",\s*\"([^\"]+)\"\)\}', inner)
    
    # Check words
    if t_match:
        zh, en = t_match[0]
        words_zh = zh.strip().split()
        words_en = en.strip().split()
    else:
        words_zh = clean.split()
        words_en = clean.split()

    is_1_word_zh = len(words_zh) <= 1
    is_1_word_en = len(words_en) <= 1

    print(f"Tag: {tag:6s} | Clean: {clean:25s} | ZH: {words_zh} | EN: {words_en} | 1-word: {is_1_word_zh and is_1_word_en}")
    if not (is_1_word_zh and is_1_word_en):
        all_1_word = False

print(f"\nStrict 1-word button compliance: {all_1_word}")
