import os
import re

html_path = r'c:\Antigravity\GatheringScans\web\index.html'

with open(html_path, 'r', encoding='utf-8') as f:
    html_lines = f.readlines()

output_path = r'c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_1\html_structure.txt'

with open(output_path, 'w', encoding='utf-8') as out:
    out.write(f"Total lines in web/index.html: {len(html_lines)}\n\n")
    out.write("--- Key DOM structures found in web/index.html ---\n")
    for i, line in enumerate(html_lines, 1):
        l = line.strip()
        if any(token in l.lower() for token in [
            '<section class="gs-view', 'id="studiocanvascontainer', 'id="view',
            'class="civil-', 'class="gs-dock', 'class="gs-side', 'class="gs-panel',
            'class="gs-modal', 'id="studioinspector', 'id="studiotoolbar', 'id="studiocivil',
            'id="compare', 'civil-panel', 'inspector-panel', 'survey-panel'
        ]):
            out.write(f"L{i:4d}: {l}\n")

print(f"Wrote html structures to {output_path}")
