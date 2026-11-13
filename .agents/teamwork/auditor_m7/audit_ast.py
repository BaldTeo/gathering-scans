import ast
import os
import re

def audit_python_file(filepath):
    print(f"=== Auditing AST of {filepath} ===")
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()

    tree = ast.parse(source, filename=filepath)
    
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    
    print(f"Classes: {[c.name for c in classes]}")
    for c in classes:
        methods = [m.name for m in c.body if isinstance(m, ast.FunctionDef)]
        print(f"  Methods in {c.name}: {methods}")
    print(f"Top-level Functions: {[f.name for f in functions]}")

    # Inspect all string literals for URLs
    urls = re.findall(r'https?://[^\s\'"<>]+', source)
    print("\nDetected HTTP/HTTPS Endpoints:")
    for u in set(urls):
        print(f"  - {u}")
        
    # Check for hardcoded mock data patterns
    mock_patterns = [
        r"mock", r"fake", r"dummy", r"sample_features", r"test_pipeline",
        r"fabricated", r"placeholder_pipes"
    ]
    print("\nScanning for suspicious mock/fake patterns:")
    found_suspicious = False
    for pat in mock_patterns:
        matches = re.findall(rf".*{pat}.*", source, re.IGNORECASE)
        for m in matches:
            # Filter out comments like 'no mock' or test docstrings if any
            print(f"  Matched pattern '{pat}': {m.strip()}")
            found_suspicious = True
    if not found_suspicious:
        print("  None found!")

    # Check network calling methods
    print("\nChecking Network Calls (urllib / requests / http):")
    net_calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func_name = ""
            if isinstance(node.func, ast.Attribute):
                func_name = node.func.attr
            elif isinstance(node.func, ast.Name):
                func_name = node.func.id
            if any(term in func_name.lower() for term in ["urlopen", "request", "get", "post", "fetch"]):
                net_calls.append((node.lineno, func_name))
    for lineno, fn in net_calls:
        print(f"  Line {lineno}: {fn}() call")

if __name__ == "__main__":
    audit_python_file("pc_worker/surveying/public_utilities_gis.py")
