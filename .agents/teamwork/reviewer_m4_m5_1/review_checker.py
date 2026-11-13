import re
import math
import numpy as np

def check_buttons():
    with open('web/src/10-construction-qa-and-stakeout.js', encoding='utf-8') as f:
        text = f.read()

    btn_pattern = re.compile(r'<button[^>]*>(.*?)</button>', re.DOTALL)
    buttons = []
    for m in btn_pattern.finditer(text):
        content = m.group(1).strip()
        clean = re.sub(r'<svg.*?</svg>', '', content, flags=re.DOTALL).strip()
        words = clean.split()
        buttons.append((clean, len(words)))
        print(f'Button text: "{clean}" (word count: {len(words)})')
    return buttons

def check_emojis():
    files = [
        'web/src/10-construction-qa-and-stakeout.js',
        'pc_worker/surveying/construction_qa.py',
        'tests/test_civil_surveying_e2e.py'
    ]
    emoji_pat = re.compile(r'[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]')
    for fp in files:
        with open(fp, encoding='utf-8') as f:
            content = f.read()
        emojis = emoji_pat.findall(content)
        print(f'{fp}: emojis count = {len(emojis)}')

def check_lines():
    import glob
    all_files = glob.glob('web/src/*.js') + glob.glob('pc_worker/surveying/*.py') + ['server.py', 'pc_worker/server_api_routes.py']
    for fp in all_files:
        with open(fp, encoding='utf-8') as f:
            lines = len(f.readlines())
        if lines > 4500:
            print(f'WARNING: {fp} has {lines} lines (approaching 5000 ceiling)')
        else:
            # print all files and lines
            pass
        print(f'{fp}: {lines} lines')

if __name__ == '__main__':
    print('--- BUTTONS ---')
    check_buttons()
    print('\n--- EMOJIS ---')
    check_emojis()
    print('\n--- LINE COUNTS ---')
    check_lines()
