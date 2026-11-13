import os
import sqlite3

def audit():
    print("=== AUDIT 1: Raw Scans in C:\\GatheringScans ===")
    base_dir = r"C:\GatheringScans"
    if os.path.exists(base_dir):
        total_files = 0
        total_bytes = 0
        subdirs = os.listdir(base_dir)
        print(f"C:\\GatheringScans directory exists. Subdirectories: {len(subdirs)}")
        for item in sorted(subdirs):
            full_p = os.path.join(base_dir, item)
            if os.path.isdir(full_p):
                f_count = 0
                b_count = 0
                for root, dirs, files in os.walk(full_p):
                    f_count += len(files)
                    for f in files:
                        try:
                            b_count += os.path.getsize(os.path.join(root, f))
                        except Exception:
                            pass
                total_files += f_count
                total_bytes += b_count
                print(f"  - {item}: {f_count} files, {b_count / (1024**3):.2f} GB ({b_count} bytes)")
        print(f"TOTAL: {total_files} files, {total_bytes / (1024**3):.2f} GB ({total_bytes} bytes)")
    else:
        print("ERROR: C:\\GatheringScans directory not found!")

    print("\n=== AUDIT 2: SQLite Database data/gathering_scans.db ===")
    db_path = os.path.join("data", "gathering_scans.db")
    if os.path.exists(db_path):
        size = os.path.getsize(db_path)
        print(f"Database exists: {db_path} ({size} bytes)")
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("PRAGMA integrity_check;")
        integrity = cur.fetchall()
        print(f"Integrity check result: {integrity}")
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [row[0] for row in cur.fetchall()]
        print(f"Found {len(tables)} tables: {tables}")
        for t in tables:
            cur.execute(f"SELECT COUNT(*) FROM `{t}`;")
            cnt = cur.fetchone()[0]
            print(f"  - {t}: {cnt} records")
        conn.close()
    else:
        print(f"ERROR: Database {db_path} not found!")

if __name__ == "__main__":
    audit()
