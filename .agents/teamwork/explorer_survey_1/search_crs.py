import glob
import os

keywords = ['UTM', 'utm', 'geoid', 'GEOID', 'TWVD', 'EGM', 'vert_offset', 'epsg', 'EPSG', 'crs', 'CRS']
out_path = r'c:\Antigravity\GatheringScans\.agents\teamwork\explorer_survey_1\crs_search.txt'

with open(out_path, 'w', encoding='utf-8') as out:
    for f in sorted(glob.glob('web/**/*.js', recursive=True) + glob.glob('web/*.html')):
        with open(f, 'r', encoding='utf-8', errors='ignore') as fp:
            for i, line in enumerate(fp, 1):
                if any(k in line for k in keywords):
                    out.write(f'{f}:{i}: {line.strip()[:100]}\n')

print(f"Wrote search to {out_path}")
