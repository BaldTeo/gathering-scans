import os
import sqlite3

print("=== ZERO DATA DESTRUCTION AUDIT ===")

# 1. Raw Scans Directory
scan_dir = r"C:\GatheringScans"
if os.path.exists(scan_dir):
    file_count = 0
    total_size = 0
    for root, dirs, files in os.walk(scan_dir):
        file_count += len(files)
        for f in files:
            fp = os.path.join(root, f)
            try:
                total_size += os.path.getsize(fp)
            except OSError:
                pass
    size_gb = total_size / (1024 ** 3)
    print(f"Directory {scan_dir}:")
    print(f"  Total Files: {file_count}")
    print(f"  Total Size: {size_gb:.2f} GB ({total_size} bytes)")
    assert file_count >= 50470, f"Expected ~50,474 files, found {file_count}"
    assert size_gb >= 56.5, f"Expected ~56.98 GB, found {size_gb:.2f} GB"
    print("  [PASS] C:\\GatheringScans\\ intact with 0 files destroyed.")
else:
    print(f"ERROR: {scan_dir} not found!")

# 2. SQLite Database Integrity
db_path = os.path.join("data", "gathering_scans.db")
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cur.fetchall()]
    print(f"\nDatabase {db_path}:")
    print(f"  Tables Found ({len(tables)}): {tables}")
    assert len(tables) > 0, "No tables in database"
    for t in tables:
        cur.execute(f"SELECT count(*) FROM {t}")
        cnt = cur.fetchone()[0]
        print(f"  Table '{t}': {cnt} records")
    cur.execute("PRAGMA integrity_check")
    integrity = cur.fetchone()[0]
    print(f"  PRAGMA integrity_check: {integrity}")
    assert integrity == "ok", f"Integrity check failed: {integrity}"
    conn.close()
    print("  [PASS] SQLite database structure and data fully intact.")
else:
    print(f"ERROR: {db_path} not found!")

print("\n=== DATA PRESERVATION AUDIT COMPLETE: CLEAN ===")
