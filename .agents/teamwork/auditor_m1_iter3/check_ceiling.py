import os

repo_root = r"C:\Antigravity\GatheringScans"
files_checked = []
violations = []

for root, dirs, files in os.walk(repo_root):
    dirs[:] = [d for d in dirs if d not in (".git", "data", "node_modules", "__pycache__", ".agent", ".agents", ".venv", "venv")]
    for fn in files:
        if fn.endswith((".py", ".js", ".css", ".html")):
            fp = os.path.join(root, fn)
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                lines = sum(1 for _ in f)
            rel_path = os.path.relpath(fp, repo_root)
            files_checked.append((lines, rel_path))
            if lines >= 5000:
                violations.append((lines, rel_path))

files_checked.sort(reverse=True)
print(f"Total files checked: {len(files_checked)}")
print(f"Violations (>= 5000 lines): {len(violations)}")
print("\nTop 20 largest files:")
for l, p in files_checked[:20]:
    print(f"  {l:5d} lines | {p}")
if violations:
    print("\nVIOLATIONS DETECTED:")
    for l, p in violations:
        print(f"  FAILED: {l} lines | {p}")
    exit(1)
else:
    print("\nALL FILES STRICTLY COMPLIANT WITH 5,000-LINE CEILING.")
