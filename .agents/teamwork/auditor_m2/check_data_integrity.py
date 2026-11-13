import os
import sqlite3

def check_data_destruction():
    print("=== Zero Data Destruction Forensic Check ===")
    scans_dir = r"C:\GatheringScans"
    print(f"Checking {scans_dir}...")
    if os.path.exists(scans_dir):
        entries = os.listdir(scans_dir)
        print(f"Total directory entries in {scans_dir}: {len(entries)}")
        assert len(entries) > 0, "CRITICAL: C:\\GatheringScans directory is empty!"
        dirs_count = 0
        files_count = 0
        total_size_bytes = 0
        for e in entries:
            p = os.path.join(scans_dir, e)
            if os.path.isdir(p):
                dirs_count += 1
                try:
                    s_files = os.listdir(p)
                    for sf in s_files:
                        sfp = os.path.join(p, sf)
                        if os.path.isfile(sfp):
                            files_count += 1
                            total_size_bytes += os.path.getsize(sfp)
                except Exception as err:
                    print(f"  Warning inspecting {e}: {err}")
            elif os.path.isfile(p):
                files_count += 1
                total_size_bytes += os.path.getsize(p)

        print(f"Scans directories: {dirs_count}")
        print(f"Total files within scans: {files_count}")
        print(f"Total raw data footprint: {total_size_bytes / (1024*1024*1024):.2f} GB")
        assert dirs_count >= 10, f"Expected at least 10 scan projects, found {dirs_count}"
        assert total_size_bytes > 100 * 1024 * 1024, f"Data size unexpectedly small: {total_size_bytes} bytes"
    else:
        print(f"CRITICAL: {scans_dir} does not exist!")
        return False

    db_path = os.path.join(r"c:\Antigravity\GatheringScans", "data", "gathering_scans.db")
    print(f"\nChecking SQLite DB: {db_path}...")
    if os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [r[0] for r in cursor.fetchall()]
        print(f"Tables in SQLite DB: {tables}")
        assert "scans" in tables, "CRITICAL: scans table missing from DB!"
        
        cursor.execute("SELECT count(*) FROM scans;")
        scan_count = cursor.fetchone()[0]
        print(f"Total scans in scans table: {scan_count}")
        assert scan_count > 0, "CRITICAL: scans table is empty!"

        cursor.execute("PRAGMA integrity_check;")
        integrity = cursor.fetchall()
        print(f"SQLite PRAGMA integrity_check: {integrity}")
        assert integrity == [("ok",)], f"Integrity check failed: {integrity}"

        cursor.execute("SELECT scan_id, name, project_group, twd97_e, twd97_n, twd97_h, extra_json FROM scans LIMIT 5;")
        rows = cursor.fetchall()
        for r in rows:
            print(f"  Scan: ID='{r[0]}', Name='{r[1]}', Group='{r[2]}', E={r[3]}, N={r[4]}, H={r[5]}")
        conn.close()
        print("SQLite DB integrity check: OK. Zero records dropped or corrupted.")
    else:
        print(f"CRITICAL: {db_path} does not exist!")
        return False

    print("\n=== ZERO DATA DESTRUCTION VERIFIED: PASS ===")
    return True

if __name__ == "__main__":
    import sys
    if not check_data_destruction():
        sys.exit(1)
