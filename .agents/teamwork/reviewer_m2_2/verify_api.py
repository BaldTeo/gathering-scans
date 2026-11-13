import urllib.request
import json

payload = {
    "scan_id": "quchi_20261005_merged",
    "generate_sample_points": True
}
req = urllib.request.Request(
    "http://127.0.0.1:8095/api/survey/gcp-qa",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("Status code: 200 OK")
        print("Keys in response:", sorted(list(data.keys())))
        
        legacy_keys = ["points", "rmse_z_m", "rmse_z_cm", "qa_grade", "qa_grade_label", "csv_url", "html_url"]
        new_3d_keys = ["gcp_residuals", "rmse_e", "rmse_n", "rmse_h", "rmse_2d", "rmse_3d", "tbm_applied", "tbm_shift_m"]
        
        missing_legacy = [k for k in legacy_keys if k not in data]
        missing_3d = [k for k in new_3d_keys if k not in data]
        
        print("Missing legacy keys:", missing_legacy)
        print("Missing new 3D keys:", missing_3d)
        
        if not missing_legacy and not missing_3d:
            print("VERDICT: All required legacy and new 3D keys are PRESENT in live /api/survey/gcp-qa response!")
        else:
            print("VERDICT: Missing keys detected!")
            
        print("Sample values:")
        print(f"  rmse_z_m: {data.get('rmse_z_m')}")
        print(f"  rmse_3d: {data.get('rmse_3d')}")
        print(f"  rmse_2d: {data.get('rmse_2d')}")
        print(f"  rmse_h: {data.get('rmse_h')}")
        print(f"  tbm_applied: {data.get('tbm_applied')}")
        print(f"  tbm_shift_m: {data.get('tbm_shift_m')}")
        print(f"  point_count: {data.get('point_count')}")
        print(f"  points len: {len(data.get('points', []))}")
        print(f"  gcp_residuals len: {len(data.get('gcp_residuals', []))}")
        if data.get("points"):
            first_pt = data["points"][0]
            print("First point keys:", sorted(list(first_pt.keys())))
except Exception as e:
    print("Request failed:", e)
